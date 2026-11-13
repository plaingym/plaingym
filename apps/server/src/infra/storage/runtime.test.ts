// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeUploads } from './runtime.js';

const gymId = '01900000-0000-7000-8000-000000000001';

describe('runtime upload regions', () => {
  it.each([
    { label: 'AWS default', env: {}, region: 'us-east-1', origin: 'https://s3.us-east-1.amazonaws.com' },
    { label: 'AWS empty', env: { UPLOADS_S3_REGION: '' }, region: 'us-east-1', origin: 'https://s3.us-east-1.amazonaws.com' },
    { label: 'AWS explicit', env: { UPLOADS_S3_REGION: 'eu-west-1' }, region: 'eu-west-1', origin: 'https://s3.eu-west-1.amazonaws.com' },
    { label: 'AWS China explicit endpoint', env: { UPLOADS_S3_ENDPOINT: 'https://s3.cn-north-1.amazonaws.com.cn', UPLOADS_S3_REGION: 'cn-north-1' }, region: 'cn-north-1', origin: 'https://s3.cn-north-1.amazonaws.com.cn' },
    { label: 'custom endpoint default', env: { UPLOADS_S3_ENDPOINT: 'https://objects.example.test/s3' }, region: 'auto', origin: 'https://objects.example.test' },
    { label: 'custom endpoint explicit', env: { UPLOADS_S3_ENDPOINT: 'https://objects.example.test/s3', UPLOADS_S3_REGION: 'eu-west-1' }, region: 'eu-west-1', origin: 'https://objects.example.test' },
  ])('uses the same region for signing and the CSP: $label', async ({ env, region, origin }) => {
    const uploads = createRuntimeUploads({ ...env, UPLOADS_S3_BUCKET: 'uploads',
      UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' }, Buffer.alloc(32), async () => 'https://gym.test');
    try {
      const store = await uploads.forGym(gymId), key = `${gymId}/image.png`;
      // Only the metadata lookup is stubbed; signing uses the real runtime client and SDK.
      vi.spyOn(store, 'head').mockResolvedValue({ key, size: 3, contentType: 'image/png', createdAt: new Date(), etag: 'test' });
      const url = new URL((await store.signedUrl(key, 60))!);
      expect(uploads.imageOrigin).toBe(origin);
      expect(url.origin).toBe(origin);
      expect(url.searchParams.get('X-Amz-Credential')).toContain(`/${region}/s3/aws4_request`);
    } finally { uploads.close(); }
  });
});
