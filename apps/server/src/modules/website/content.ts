// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { idSchema, maxWebsitePhotos, websitePhotoTypes, websiteSettingsSchema as sharedSettingsSchema } from '@plaingym/shared/contracts';

// The request and response schemas live in the shared contracts (`websiteContracts`); this file keeps what is stored.
export { removeWebsiteLogoRequestSchema as removeLogoRequestSchema, updateWebsiteRequestSchema, uploadWebsiteLogoRequestSchema as uploadLogoRequestSchema,
  uploadWebsitePhotoRequestSchema as uploadPhotoRequestSchema, type UpdateWebsiteRequest, type WebsiteSettings } from '@plaingym/shared/contracts';
export const maxPhotos = maxWebsitePhotos;
export const photoTypes = websitePhotoTypes;
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

/** The OpenAPI document names the settings component. */
export const websiteSettingsSchema = sharedSettingsSchema.openapi('WebsiteSettings');
export const websiteSettingsResponseSchema = z.strictObject({ data: websiteSettingsSchema });
export const photoParamsSchema = z.object({ photoId: idSchema });
export const coachParamsSchema = z.object({ staffProfileId: idSchema });
