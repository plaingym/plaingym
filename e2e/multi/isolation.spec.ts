// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client } from '../support.js';
import { signaturePng } from '../portal.js';
import { multiGyms, type Context } from './support.js';

interface WebsiteSettings {
  revision: number; tagline: string | null; about: string | null; phone: string | null; email: string | null;
  primaryColor: string | null; accentColor: string | null; logo: boolean; logoVersion: string | null; photos: { id: string; alt: string }[];
}
test.use({ trace: 'off', screenshot: 'off' });

test('public record-ID routes isolate waiver documents and website images on both gym hosts', async () => {
  test.setTimeout(180_000);
  const gyms = await multiGyms();
  const originals: { gym: Context; enabled: boolean }[] = [];
  const records: { gym: Context; profileId: string; photoId: string; token: string }[] = [];
  const profiles: { gym: Context; id: string }[] = [];
  const photos: { gym: Context; id: string }[] = [];
  try {
    for (const gym of gyms) {
      const settings = (await gym.owner.json<{ data: { revision: number; websiteEnabled: boolean } }>('/api/settings')).data;
      originals.push({ gym, enabled: settings.websiteEnabled });
      if (!settings.websiteEnabled) await gym.owner.json('/api/settings', 'PATCH', { revision: settings.revision, websiteEnabled: true });
      const profile = (await gym.owner.json<{ data: { id: string; revision: number } }>('/api/staff/profiles', 'POST',
        { displayName: gym.name + ' public coach', isPublic: true })).data;
      profiles.push({ gym, id: profile.id });
      const image = { contentType: 'image/png', base64: signaturePng().toString('base64') };
      await gym.owner.json(`/api/staff/profiles/${profile.id}/photo`, 'POST', { revision: profile.revision, ...image });
      const website = (await gym.owner.json<{ data: { revision: number } }>('/api/website')).data;
      const photo = (await gym.owner.json<{ data: { photos: { id: string }[] } }>('/api/website/photos', 'POST',
        { revision: website.revision, ...image, alt: gym.name + ' mats' })).data.photos.at(-1)!;
      photos.push({ gym, id: photo.id });
      const link = (await gym.owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose: 'sign_waiver',
        householdId: gym.householdId, memberId: gym.student.id, expiresAt: new Date(Date.now() + 3600000).toISOString() })).data;
      records.push({ gym, profileId: profile.id, photoId: photo.id, token: link.token });
    }
    for (const own of records) {
      const other = records.find(record => record.gym.slug !== own.gym.slug)!;
      const guest = new Client(own.gym.origin);
      const cases = [
        { name: 'public waiver document', path: (record: typeof own) => `/api/public/waivers/${record.gym.templateId}/document`, status: 200 },
        { name: 'signed-link waiver document', path: (record: typeof own) => `/l/${own.token}/documents/${record.gym.templateId}`, status: 302 },
        { name: 'public coach photo', path: (record: typeof own) => `/website/coaches/${record.profileId}/photo`, status: 200 },
        { name: 'public website photo', path: (record: typeof own) => `/website/photos/${record.photoId}`, status: 200 },
      ];
      for (const entry of cases) {
        expect((await guest.request(entry.path(own))).status, own.gym.slug + ' own ' + entry.name).toBe(entry.status);
        expect((await guest.request(entry.path(other))).status, own.gym.slug + ' foreign ' + entry.name).toBe(404);
      }
    }
  } finally {
    // Register each resource immediately, so a later setup/assertion failure still cleans it.
    try {
      await Promise.all(profiles.map(async ({ gym, id }) => {
        const profile = (await gym.owner.json<{ data: { revision: number } }>(`/api/staff/profiles/${id}`)).data;
        await gym.owner.json(`/api/staff/profiles/${id}`, 'PATCH', { revision: profile.revision, isPublic: false, photoKey: null });
      }));
    } finally {
      try {
        await Promise.all(photos.map(async ({ gym, id }) => {
          const website = (await gym.owner.json<{ data: WebsiteSettings }>('/api/website')).data;
          const { revision, tagline, about, phone, email, accentColor, primaryColor } = website;
          await gym.owner.json('/api/website', 'PUT', { revision, tagline, about, phone, email, accentColor, primaryColor,
            photos: website.photos.filter(photo => photo.id !== id) });
        }));
      } finally {
        for (const { gym, enabled } of originals) {
          const settings = (await gym.owner.json<{ data: { revision: number; websiteEnabled: boolean } }>('/api/settings')).data;
          if (settings.websiteEnabled !== enabled) await gym.owner.json('/api/settings', 'PATCH', { revision: settings.revision, websiteEnabled: enabled });
        }
      }
    }
  }
});
