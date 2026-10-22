// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { canStaff } from '@plaingym/shared';
import type { Clock, RegistryEntry, StaffPermission, StaffRole } from '@plaingym/shared';
import type { Id, IsoDate, IsoInstant } from '@plaingym/shared/contracts';
import { notFound, scopedKey } from './common.js';
import type { AttendanceScope } from './attendance.js';

export interface CriterionContext {
  /** Forward to attendance queries so portal evaluation retains its household scope. */
  readonly attendanceScope: AttendanceScope;
  readonly gymId: Id;
  readonly memberId: Id;
  readonly programId: Id;
  readonly rankId: Id;
  readonly promotedAt: IsoInstant | null;
  readonly dateOfBirth: IsoDate | null;
  readonly clock: Clock;
}
export interface CriterionProgress { readonly current: number; readonly target: number; readonly met: boolean; }
export interface PromotionCriterionProvider<Config = unknown> extends RegistryEntry {
  readonly labelKey: string;
  readonly configSchema: z.ZodType<Config>;
  evaluate(context: CriterionContext, config: Config): Promise<CriterionProgress>;
}
export const targetCriterionSchema = z.strictObject({ target: z.number().positive().finite() });
export type TargetCriterion = z.infer<typeof targetCriterionSchema>;
/** Canned measurements; eligibility still evaluates the configured target. */
export class FakePromotionCriterionProvider implements PromotionCriterionProvider<TargetCriterion> {
  readonly configSchema = targetCriterionSchema;
  readonly #measurements = new Map<string, number>();
  constructor(readonly id: string, readonly labelKey: string) {}
  #key(context: Pick<CriterionContext, 'gymId' | 'memberId' | 'programId' | 'rankId' | 'promotedAt'>): string {
    return JSON.stringify([scopedKey(context.gymId, context.memberId), context.programId, context.rankId, context.promotedAt]);
  }
  setProgress(context: Pick<CriterionContext, 'gymId' | 'memberId' | 'programId' | 'rankId' | 'promotedAt'>, current: number): void {
    if (!Number.isFinite(current) || current < 0) throw new Error('Invalid criterion progress');
    this.#measurements.set(this.#key(context), current);
  }
  async evaluate(context: CriterionContext, config: TargetCriterion): Promise<CriterionProgress> {
    const { target } = this.configSchema.parse(config);
    const current = this.#measurements.get(this.#key(context)) ?? 0;
    return { current, target, met: current >= target };
  }
}

export interface StandingContext { readonly gymId: Id; readonly memberId: Id; readonly clock: Clock; }
/** Internal only: kiosk routes expose the neutral front-desk message, never reasonCode. */
export type StandingResult = { readonly status: 'ok' } | { readonly status: 'front_desk'; readonly reasonCode: string };
export interface KioskStandingCheck extends RegistryEntry { check(context: StandingContext): Promise<StandingResult>; }
export class FakeKioskStandingCheck implements KioskStandingCheck {
  readonly #results = new Map<string, StandingResult>();
  constructor(readonly id: string) {}
  set(gymId: Id, memberId: Id, result: StandingResult): void {
    this.#results.set(scopedKey(gymId, memberId), result.status === 'ok'
      ? { status: 'ok' } : { status: 'front_desk', reasonCode: result.reasonCode });
  }
  async check(context: StandingContext): Promise<StandingResult> {
    return structuredClone(this.#results.get(scopedKey(context.gymId, context.memberId)) ?? { status: 'ok' });
  }
}

export interface StaffProviderContext { readonly gymId: Id; readonly roles: readonly StaffRole[]; readonly clock: Clock; }
/** Structural base; the shared area contract supplies the full discriminated schema. */
export interface DashboardWidgetData {
  readonly id: string;
  readonly titleKey: string;
  readonly status: 'ready' | 'not_configured' | 'unavailable';
}
export interface DashboardWidgetProvider<Widget extends DashboardWidgetData = DashboardWidgetData> extends RegistryEntry {
  readonly id: Widget['id'];
  readonly permission: StaffPermission;
  readonly schema: z.ZodType<Widget>;
  read(context: StaffProviderContext): Promise<Widget>;
}
/** Pass the shared widget schema so the fake preserves that widget's precise payload. */
export class FakeDashboardWidgetProvider<Widget extends DashboardWidgetData> implements DashboardWidgetProvider<Widget> {
  readonly #widgets = new Map<Id, Widget>();
  constructor(readonly id: Widget['id'], readonly permission: StaffPermission, readonly schema: z.ZodType<Widget>) {}
  set(gymId: Id, widget: Widget): void {
    if (widget.id !== this.id) throw new Error('Widget ID does not match provider');
    this.#widgets.set(gymId, structuredClone(this.schema.parse(widget)));
  }
  async read(context: StaffProviderContext): Promise<Widget> {
    if (!canStaff(context.roles, this.permission)) notFound();
    return structuredClone(this.#widgets.get(context.gymId) ?? notFound());
  }
}

/** Structural base; the shared health schema defines each tile's detail fields. */
export interface HealthTileData {
  readonly id: string;
  readonly status: 'healthy' | 'warning' | 'error' | 'not_configured' | 'unavailable';
  readonly message: string;
  readonly checkedAt: IsoInstant | null;
  readonly details: unknown;
}
export interface HealthTileProvider<Tile extends HealthTileData = HealthTileData> extends RegistryEntry {
  readonly id: Tile['id'];
  readonly permission: StaffPermission;
  readonly schema: z.ZodType<Tile>;
  read(context: StaffProviderContext): Promise<Tile>;
}
export class FakeHealthTileProvider<Tile extends HealthTileData> implements HealthTileProvider<Tile> {
  readonly permission = 'settings.manage' as const;
  readonly #tiles = new Map<Id, Omit<Tile, 'checkedAt'>>();
  constructor(readonly id: Tile['id'], readonly schema: z.ZodType<Tile>) {}
  set(gymId: Id, tile: Omit<Tile, 'checkedAt'>): void {
    if (tile.id !== this.id) throw new Error('Health tile ID does not match provider');
    this.#tiles.set(gymId, structuredClone(tile));
  }
  async read(context: StaffProviderContext): Promise<Tile> {
    if (!canStaff(context.roles, this.permission)) notFound();
    const tile = this.#tiles.get(context.gymId) ?? notFound();
    return this.schema.parse({ ...structuredClone(tile), checkedAt: context.clock.now().toISOString() });
  }
}
