// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { RoutePermission } from '../permissions.js';
import type { EndpointContract } from './definition.js';
import { idSchema, revisionSchema } from './common.js';

/** Request and response shapes of the website's customization API (`/api/website`), shared by the server and the admin. */
export const maxWebsitePhotos = 8;
export const websitePhotoTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
const manage = { kind: 'staff', capability: 'settings.manage' } as const satisfies RoutePermission;

/** What the admin reads: the website's text, colors and photo list, and whether the gym has a logo. */
export const websiteSettingsSchema = z.strictObject({
  revision: revisionSchema, tagline: z.string().nullable(), about: z.string().nullable(), phone: z.string().nullable(),
  email: z.string().nullable(), accentColor: z.string().nullable(), primaryColor: z.string().nullable(),
  logo: z.boolean(), logoVersion: z.string().regex(/^[0-9a-f]{12}$/).nullable(), photos: z.array(z.strictObject({ id: idSchema, alt: z.string() })),
});
export type WebsiteSettings = z.infer<typeof websiteSettingsSchema>;
export const websiteSettingsResponseSchema = z.strictObject({ data: websiteSettingsSchema });

/** Text, colors and the photo list. Photos are added by upload; this reorders them, edits their text and removes any left out. */
export const updateWebsiteRequestSchema = z.strictObject({
  revision: revisionSchema, tagline: optionalText(160), about: optionalText(5000), phone: optionalText(40),
  email: z.email().max(254).nullable(), accentColor: color.nullable(), primaryColor: color.nullable(),
  photos: z.array(z.strictObject({ id: idSchema, alt: z.string().trim().max(200) })).max(maxWebsitePhotos)
    .refine((photos) => new Set(photos.map((photo) => photo.id)).size === photos.length, 'List each photo once'),
});
export type UpdateWebsiteRequest = z.infer<typeof updateWebsiteRequestSchema>;
/** Base64 image bytes, at most 512 KiB once decoded (the same limit as staff and member photos). */
const imageUpload = { revision: revisionSchema, contentType: z.enum(websitePhotoTypes), base64: z.string().min(1).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) };
export const uploadWebsitePhotoRequestSchema = z.strictObject({ ...imageUpload, alt: z.string().trim().max(200) });
export const uploadWebsiteLogoRequestSchema = z.strictObject(imageUpload);
export const removeWebsiteLogoRequestSchema = z.strictObject({ revision: revisionSchema });

/** The customization endpoints. The pages, `theme.css`, the photo routes and the sitemap are public and have no contract. */
export const websiteContracts = {
  get: { method: 'get', path: '/api/website', permission: manage, response: websiteSettingsResponseSchema },
  update: { method: 'put', path: '/api/website', permission: manage, body: updateWebsiteRequestSchema, response: websiteSettingsResponseSchema },
  uploadPhoto: { method: 'post', path: '/api/website/photos', permission: manage, body: uploadWebsitePhotoRequestSchema, response: websiteSettingsResponseSchema },
  uploadLogo: { method: 'post', path: '/api/website/logo', permission: manage, body: uploadWebsiteLogoRequestSchema, response: websiteSettingsResponseSchema },
  removeLogo: { method: 'delete', path: '/api/website/logo', permission: manage, body: removeWebsiteLogoRequestSchema, response: websiteSettingsResponseSchema },
} as const satisfies Record<string, EndpointContract>;
