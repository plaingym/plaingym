// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { forGym, uuidv7, RevisionConflictError, classSessionPrograms, classSessions, classTemplatePrograms, classTemplates,
  planTaxRates, plans, programs, staffProfiles, taxRates, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { GymAddress, GymBranding } from '@plaingym/shared/contracts';
import { addDays, localDate, startOfWeek, weekday, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Uploads } from '../../infra/storage/index.js';
import { createModuleSettings, readGymAndModuleSettings, type ModuleSettings } from '../../areas/settings/module-settings.js';
import { serveGymImage } from '../../public/pages/service.js';
import { logoVersion } from '../../public/short-hash.js';
import { addsTaxOnTop } from '../../areas/billing/invoicing/adds-tax-on-top.js';
import { validatePhoto } from '../../areas/members/photos.js';
import { releaseFiles } from '../../infra/storage/release.js';
import { maxPhotos, storedContent, type StoredContent, type UpdateWebsiteRequest, type WebsiteSettings,
  uploadLogoRequestSchema, uploadPhotoRequestSchema, removeLogoRequestSchema, updateWebsiteRequestSchema } from './content.js';

export const moduleId = 'website';
export interface WebsiteOptions {
  readonly scope?: typeof forGym;
  readonly clock?: Clock;
  /** The runtime passes `uploads.forGym`; without it photo and logo uploads and photo reads fail closed. */
  readonly uploadsFor?: (gymId: string) => Promise<Uploads>;
}
export interface SiteClass {
  readonly id: string; readonly name: string; readonly weekday: number; readonly localStartTime: string;
  readonly durationMinutes: number; readonly kind: 'class' | 'open_mat'; readonly coach: string | null; readonly programIds: readonly string[];
}
export interface SitePlan {
  readonly id: string; readonly name: string; readonly amountCents: number; readonly currency: string; readonly interval: 'monthly' | 'annual';
  readonly plusTax: boolean; readonly signupFeeCents: number; readonly trialDays: number; readonly commitmentMonths: number | null;
}
export interface SiteCoach { readonly id: string; readonly displayName: string; readonly bio: string | null; readonly rank: string | null; readonly photo: boolean }
/**
 * A session this week that differs from the weekly timetable: cancelled, added for one day only, or moved from the time
 * its template set. `date` and `localStartTime` are the gym's local wall time.
 */
export interface SiteSession {
  readonly id: string; readonly name: string; readonly date: string; readonly localStartTime: string; readonly durationMinutes: number;
  readonly kind: 'class' | 'open_mat'; readonly coach: string | null; readonly programIds: readonly string[];
  readonly change: 'cancelled' | 'one_off' | 'moved';
}
/** Everything a website page shows: public gym data only, read in one short transaction. */
export interface Site {
  readonly gym: { readonly name: string; readonly revision: number; readonly timezone: string; readonly address: GymAddress;
    /** The logo's URL version (it changes with the file, not with settings saves), or null without a logo. */
    readonly logoVersion: string | null; readonly primaryColor: string | null; readonly updatedAt: string };
  readonly content: StoredContent;
  readonly programs: readonly { readonly id: string; readonly name: string }[];
  readonly classes: readonly SiteClass[];
  readonly sessions: readonly SiteSession[];
  readonly plans: readonly SitePlan[];
  readonly coaches: readonly SiteCoach[];
}
export type SitePart = 'programs' | 'classes' | 'sessions' | 'plans' | 'coaches';

const missing = (what = 'Not found'): never => { throw new AppError('not_found', what); };
const ownLogo = (gymId: string, key: string | null | undefined): key is string => !!key && key.startsWith(`${gymId}/website/logo/`);
/** Monday first, the order a weekly timetable reads in most places; weekday 0 is Sunday. */
const weekOrder = (weekday: number) => (weekday + 6) % 7;

function present(saved: ModuleSettings): WebsiteSettings {
  const content = storedContent(saved.value);
  return { revision: saved.revision, tagline: content.tagline, about: content.about, phone: content.phone, email: content.email,
    accentColor: content.accentColor, primaryColor: saved.branding.primaryColor ?? null, logo: !!saved.branding.logoKey,
    logoVersion: saved.branding.logoKey ? logoVersion(saved.branding.logoKey) : null,
    photos: content.photos.map(({ id, alt }) => ({ id, alt })) };
}
/** The branding with a new primary color, or none (the default theme). */
function withPrimaryColor(branding: GymBranding, primaryColor: string | null): GymBranding {
  return { ...branding, primaryColor };
}

async function readPlans(tx: Transaction, currency: string): Promise<SitePlan[]> {
  const rows = await tx.select().from(plans).where(and(eq(plans.active, true), eq(plans.currency, currency)))
    .orderBy(asc(plans.amountCents), asc(plans.name), asc(plans.id));
  // Invoicing adds tax on top for an attached rate that is exclusive and above zero (the join page's rule).
  const taxed = rows.length ? new Set((await tx.selectDistinct({ planId: planTaxRates.planId }).from(planTaxRates)
    .innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId))
    .where(and(inArray(planTaxRates.planId, rows.map((row) => row.id)), addsTaxOnTop))).map((row) => row.planId)) : new Set<string>();
  return rows.map((row) => ({ id: row.id, name: row.name, amountCents: row.amountCents, currency: row.currency,
    interval: row.interval as SitePlan['interval'], plusTax: taxed.has(row.id), signupFeeCents: row.signupFeeCents,
    trialDays: row.trialDays, commitmentMonths: row.commitmentMonths }));
}
async function readClasses(tx: Transaction, active: ReadonlySet<string>): Promise<SiteClass[]> {
  const rows = await tx.select({ id: classTemplates.id, name: classTemplates.name, weekday: classTemplates.weekday,
    localStartTime: classTemplates.localStartTime, durationMinutes: classTemplates.durationMinutes, kind: classTemplates.kind,
    coach: staffProfiles.displayName, coachPublic: staffProfiles.isPublic })
    .from(classTemplates).leftJoin(staffProfiles, eq(staffProfiles.id, classTemplates.coachId));
  const links = rows.length ? await tx.select({ templateId: classTemplatePrograms.templateId, programId: classTemplatePrograms.programId })
    .from(classTemplatePrograms).where(inArray(classTemplatePrograms.templateId, rows.map((row) => row.id))) : [];
  return rows.map((row) => ({ id: row.id, name: row.name, weekday: row.weekday, localStartTime: row.localStartTime,
    durationMinutes: row.durationMinutes, kind: row.kind === 'open_mat' ? 'open_mat' as const : 'class' as const,
    // Only a coach whose profile is public is named on the website.
    coach: row.coachPublic ? row.coach : null,
    programIds: links.filter((link) => link.templateId === row.id && active.has(link.programId)).map((link) => link.programId) }))
    .sort((a, b) => weekOrder(a.weekday) - weekOrder(b.weekday) || a.localStartTime.localeCompare(b.localStartTime) || a.name.localeCompare(b.name));
}

/** `HH:MM` on the wall clock of `timezone`: display formatting of an instant the database already holds. */
const wallClock = (instant: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(instant);
/**
 * This week's sessions (Monday to Sunday in the gym's zone) that differ from the weekly timetable as it stands now:
 * cancelled ones, ones without a template (added for one day, or left by a deleted template) and ones whose local
 * weekday or start time isn't their template's (moved, or kept at the old time after the template changed). A session
 * whose occurrence falls in this week but which was moved into another week is listed too, at its new date.
 */
async function readSessions(tx: Transaction, now: Date, timezone: string, active: ReadonlySet<string>): Promise<SiteSession[]> {
  const today = localDate(now, timezone), monday = startOfWeek(today);
  const from = zonedInstant(monday, '00:00', timezone, { gap: 'shift' })!, to = zonedInstant(addDays(monday, 7), '00:00', timezone, { gap: 'shift' })!;
  const rows = await tx.select({ id: classSessions.id, name: classSessions.name, startsAt: classSessions.startsAt, endsAt: classSessions.endsAt,
    kind: classSessions.kind, status: classSessions.status, templateWeekday: classTemplates.weekday, templateStartTime: classTemplates.localStartTime,
    coach: staffProfiles.displayName, coachPublic: staffProfiles.isPublic })
    .from(classSessions).leftJoin(staffProfiles, eq(staffProfiles.id, classSessions.coachId))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .where(or(and(gte(classSessions.startsAt, from), lt(classSessions.startsAt, to)),
      and(gte(classSessions.occurrenceStartsAt, from), lt(classSessions.occurrenceStartsAt, to))))
    .orderBy(asc(classSessions.startsAt), asc(classSessions.name), asc(classSessions.id));
  const changed = rows.flatMap((row) => {
    const date = localDate(row.startsAt, timezone), localStartTime = wallClock(row.startsAt, timezone);
    const change = row.status === 'cancelled' ? 'cancelled' as const : row.templateWeekday === null ? 'one_off' as const
      : row.templateWeekday !== weekday(date) || row.templateStartTime !== localStartTime ? 'moved' as const : null;
    return change ? [{ row, date, localStartTime, change }] : [];
  });
  const links = changed.length ? await tx.select({ sessionId: classSessionPrograms.sessionId, programId: classSessionPrograms.programId })
    .from(classSessionPrograms).where(inArray(classSessionPrograms.sessionId, changed.map(({ row }) => row.id))) : [];
  return changed.map(({ row, date, localStartTime, change }) => ({ id: row.id, name: row.name, date, localStartTime,
    durationMinutes: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000), kind: row.kind === 'open_mat' ? 'open_mat' as const : 'class' as const,
    coach: row.coachPublic ? row.coach : null,
    programIds: links.filter((link) => link.sessionId === row.id && active.has(link.programId)).map((link) => link.programId), change }));
}

export function createWebsiteService(options: WebsiteOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const store = createModuleSettings({ scope, clock });
  const uploads = async (gymId: string) => options.uploadsFor ? options.uploadsFor(gymId) : missing();
  /** Streams one of the gym's own uploads, or 404 for a key from elsewhere, a deleted file, an unexpected type or one over the size cap. */
  async function stream(gymId: string, key: string, prefix: string) {
    return serveGymImage(await uploads(gymId), gymId, key, `${gymId}/${prefix}`);
  }
  /** Marks files deleted once the save that released them committed (a storage failure is logged; see `releaseFiles`). */
  const release = (gymId: string, keys: readonly string[]) => releaseFiles(gymId, keys, uploads, 'website.release_failed');
  async function current(gymId: string, revision: number) {
    const saved = await store.get(gymId, moduleId);
    if (saved.revision !== revision) throw new RevisionConflictError();
    return saved;
  }
  /** Stores the bytes under a new key, then saves; a save that fails marks the new file deleted. */
  async function stored<T>(gymId: string, prefix: string, bytes: Uint8Array, contentType: string, save: (key: string) => Promise<T>) {
    validatePhoto(bytes, contentType);
    const files = await uploads(gymId), key = `${gymId}/website/${prefix}/${uuidv7(clock.now().getTime())}`;
    await files.put(key, bytes, contentType);
    try { return await save(key); }
    catch (error) { await release(gymId, [key]); throw error; }
  }
  return {
    async site(gymId: string, parts: readonly SitePart[] = []): Promise<Site> {
      const want = new Set(parts);
      return scope(gymId, async (tx) => {
        const { gym, module: saved } = await readGymAndModuleSettings(tx, gymId, moduleId);
        const active = want.has('programs') || want.has('classes') || want.has('sessions')
          ? await tx.select({ id: programs.id, name: programs.name }).from(programs).where(eq(programs.active, true)).orderBy(asc(programs.name)) : [];
        const coaches = want.has('coaches') ? await tx.select({ id: staffProfiles.id, displayName: staffProfiles.displayName, bio: staffProfiles.bio,
          rank: staffProfiles.rank, photoKey: staffProfiles.photoKey }).from(staffProfiles).where(eq(staffProfiles.isPublic, true))
          .orderBy(asc(staffProfiles.displayName), asc(staffProfiles.id)) : [];
        return {
          gym: { name: gym.name, revision: gym.revision, timezone: gym.timezone, address: gym.address,
            logoVersion: gym.branding.logoKey ? logoVersion(gym.branding.logoKey) : null, primaryColor: gym.branding.primaryColor ?? null, updatedAt: gym.updatedAt },
          content: storedContent(saved.value),
          programs: want.has('programs') ? active : [],
          classes: want.has('classes') ? await readClasses(tx, new Set(active.map((program) => program.id))) : [],
          sessions: want.has('sessions') ? await readSessions(tx, clock.now(), gym.timezone, new Set(active.map((program) => program.id))) : [],
          plans: want.has('plans') ? await readPlans(tx, gym.currency) : [],
          coaches: coaches.map(({ photoKey, ...coach }) => ({ ...coach, photo: !!photoKey })),
        };
      });
    },
    async settings(gymId: string) { return present(await store.get(gymId, moduleId)); },
    async update(context: MutationContext, body: UpdateWebsiteRequest) {
      const input = updateWebsiteRequestSchema.parse(body);
      let removed: string[] = [];
      const saved = await store.save(context, moduleId, input.revision, ({ value, branding }) => {
        const content = storedContent(value);
        const photos = input.photos.map(({ id, alt }) => ({ ...(content.photos.find((photo) => photo.id === id) ?? missing('Photo not found')), alt }));
        removed = content.photos.filter((photo) => !photos.some((kept) => kept.id === photo.id)).map((photo) => photo.key);
        return { value: { ...content, tagline: input.tagline || null, about: input.about || null, phone: input.phone || null,
          email: input.email, accentColor: input.accentColor, photos }, branding: withPrimaryColor(branding, input.primaryColor) };
      });
      // Storage calls run after the save commits: a removed photo stays readable until the uploads sweep.
      await release(context.gymId, removed);
      return present(saved);
    },
    async uploadPhoto(context: MutationContext, body: unknown) {
      const input = uploadPhotoRequestSchema.parse(body);
      const before = storedContent((await current(context.gymId, input.revision)).value);
      if (before.photos.length >= maxPhotos) throw new AppError('conflict', 'Remove a photo before adding another');
      return present(await stored(context.gymId, 'photos', Buffer.from(input.base64, 'base64'), input.contentType, (key) =>
        store.save(context, moduleId, input.revision, ({ value }) => {
          const content = storedContent(value);
          if (content.photos.length >= maxPhotos) throw new AppError('conflict', 'Remove a photo before adding another');
          return { value: { ...content, photos: [...content.photos, { id: uuidv7(clock.now().getTime()), key, contentType: input.contentType, alt: input.alt }] } };
        })));
    },
    async uploadLogo(context: MutationContext, body: unknown) {
      const input = uploadLogoRequestSchema.parse(body);
      await current(context.gymId, input.revision);
      let previous: string | null | undefined;
      const saved = await stored(context.gymId, 'logo', Buffer.from(input.base64, 'base64'), input.contentType, (key) =>
        store.save(context, moduleId, input.revision, ({ value, branding }) => {
          previous = branding.logoKey;
          return { value, branding: { ...branding, logoKey: key } };
        }));
      // Only a logo this module uploaded is released; a key set some other way may still be in use.
      if (ownLogo(context.gymId, previous)) await release(context.gymId, [previous]);
      return present(saved);
    },
    async removeLogo(context: MutationContext, body: unknown) {
      const input = removeLogoRequestSchema.parse(body);
      let previous: string | null | undefined;
      const saved = await store.save(context, moduleId, input.revision, ({ value, branding }) => {
        previous = branding.logoKey;
        return { value, branding: { ...branding, logoKey: null } };
      });
      if (ownLogo(context.gymId, previous)) await release(context.gymId, [previous]);
      return present(saved);
    },
    async photo(gymId: string, photoId: string) {
      const content = storedContent((await store.get(gymId, moduleId)).value);
      const photo = content.photos.find((item) => item.id === photoId) ?? missing('Photo not found');
      return stream(gymId, photo.key, 'website/photos/');
    },
    /** A coach's photo, only while the profile is public. */
    async coachPhoto(gymId: string, staffProfileId: string) {
      const [profile] = await scope(gymId, (tx) => tx.select({ photoKey: staffProfiles.photoKey }).from(staffProfiles)
        .where(and(eq(staffProfiles.id, staffProfileId), eq(staffProfiles.isPublic, true))));
      return profile?.photoKey ? stream(gymId, profile.photoKey, 'staff/') : missing('Photo not found');
    },
  };
}
export type WebsiteService = ReturnType<typeof createWebsiteService>;
