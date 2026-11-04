// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { idSchema, revisionSchema } from '@plaingym/shared/contracts';

// TODO(CCR): move these request and response schemas into the shared contracts (`websiteContracts`).
export const maxPhotos = 8;
export const photoTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionalText = (max: number) => z.string().trim().max(max).nullable();

/** One stored photo: its upload key stays on the server; pages and the admin address it by ID. */
export const storedPhotoSchema = z.strictObject({
  id: idSchema, key: z.string().min(1), contentType: z.enum(photoTypes), alt: z.string().trim().max(200),
});
/** What the website module keeps in the gym's module settings. Branding (logo, primary color) stays in `gyms.branding`. */
export const storedContentSchema = z.strictObject({
  tagline: optionalText(160), about: optionalText(5000), phone: optionalText(40),
  email: z.email().max(254).nullable(), accentColor: color.nullable(),
  photos: z.array(storedPhotoSchema).max(maxPhotos),
});
export type StoredContent = z.infer<typeof storedContentSchema>;
export const emptyContent: StoredContent = { tagline: null, about: null, phone: null, email: null, accentColor: null, photos: [] };
/** A stored value that doesn't parse (none saved yet, or written by an older release) reads as empty. */
export const storedContent = (value: unknown): StoredContent => {
  const parsed = storedContentSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyContent;
};

const photoSchema = z.strictObject({ id: idSchema, alt: z.string() });
export const websiteSettingsSchema = z.strictObject({
  revision: revisionSchema, tagline: z.string().nullable(), about: z.string().nullable(), phone: z.string().nullable(),
  email: z.string().nullable(), accentColor: z.string().nullable(), primaryColor: z.string().nullable(),
  logo: z.boolean(), photos: z.array(photoSchema),
}).openapi('WebsiteSettings');
export const websiteSettingsResponseSchema = z.strictObject({ data: websiteSettingsSchema });
export type WebsiteSettings = z.infer<typeof websiteSettingsSchema>;

/** Text, colors and the photo list. Photos are added by upload; this reorders them, edits their text and removes any left out. */
export const updateWebsiteRequestSchema = z.strictObject({
  revision: revisionSchema, tagline: optionalText(160), about: optionalText(5000), phone: optionalText(40),
  email: z.email().max(254).nullable(), accentColor: color.nullable(), primaryColor: color.nullable(),
  photos: z.array(z.strictObject({ id: idSchema, alt: z.string().trim().max(200) })).max(maxPhotos)
    .refine((photos) => new Set(photos.map((photo) => photo.id)).size === photos.length, 'List each photo once'),
});
export type UpdateWebsiteRequest = z.infer<typeof updateWebsiteRequestSchema>;
/** Base64 image bytes, at most 512 KiB once decoded (the same limit as staff and member photos). */
const imageUpload = { revision: revisionSchema, contentType: z.enum(photoTypes), base64: z.string().min(1).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) };
export const uploadPhotoRequestSchema = z.strictObject({ ...imageUpload, alt: z.string().trim().max(200) });
export const uploadLogoRequestSchema = z.strictObject(imageUpload);
export const removeLogoRequestSchema = z.strictObject({ revision: revisionSchema });
export const photoParamsSchema = z.object({ photoId: idSchema });
export const coachParamsSchema = z.object({ staffProfileId: idSchema });
