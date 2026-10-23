// SPDX-License-Identifier: AGPL-3.0-only
import { uuidv7, RevisionConflictError } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Uploads } from '../../infra/storage/index.js';
import type { MembersService } from './members.js';

export type MemberUploads = (gymId: string) => Promise<Uploads>;
export const maxPhotoBytes = 512 * 1024;
export function validatePhoto(bytes: Uint8Array, contentType: string) {
  const png = bytes.length >= 24 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP';
  if (!bytes.length || bytes.length > maxPhotoBytes || !(contentType === 'image/png' && png || contentType === 'image/jpeg' && jpeg || contentType === 'image/webp' && webp))
    throw new AppError('invalid_request', 'Invalid photo');
}
export function createMemberPhotoService(members: MembersService, uploadsFor: MemberUploads) {
  return {
    async upload(context: MutationContext, memberId: string, revision: number, bytes: Uint8Array, contentType: string) {
      const before = await members.getMember(context.gymId, memberId);
      if (before.anonymizedAt) throw new AppError('conflict', 'Anonymized profiles cannot be edited');
      if (before.revision !== revision) throw new RevisionConflictError();
      validatePhoto(bytes, contentType);
      const uploads = await uploadsFor(context.gymId), key = `${context.gymId}/members/${memberId}/${uuidv7()}`;
      await uploads.put(key, bytes, contentType);
      let saved;
      try { saved = await members.attachPhoto(context, memberId, revision, key); }
      catch (error) { await uploads.markDeleted(key); throw error; }
      if (before.photoKey) await uploads.markDeleted(before.photoKey);
      return saved;
    },
    async read(gymId: string, memberId: string) {
      const profile = await members.getMember(gymId, memberId);
      if (!profile.photoKey || profile.anonymizedAt) throw new AppError('not_found', 'Photo not found');
      const uploads = await uploadsFor(gymId), metadata = await uploads.head(profile.photoKey);
      if (!metadata || metadata.deletedAt) throw new AppError('not_found', 'Photo not found');
      const stream = await uploads.get(profile.photoKey);
      if (!stream) throw new AppError('not_found', 'Photo not found');
      return { stream, contentType: metadata.contentType };
    },
    /** Storage calls happen after the erasure commits: the photo and signed-waiver images it released. */
    async anonymize(context: MutationContext, memberId: string, revision: number) {
      const { member, files } = await members.eraseMember(context, memberId, { revision });
      const uploads = files.length ? await uploadsFor(context.gymId) : undefined;
      for (const key of files) await uploads!.markDeleted(key);
      return member;
    },
    async update(context: MutationContext, memberId: string, input: Parameters<MembersService['updateMember']>[2]) {
      const before = await members.getMember(context.gymId, memberId);
      const saved = await members.updateMember(context, memberId, input);
      if (before.photoKey && saved.photoKey === null) await (await uploadsFor(context.gymId)).markDeleted(before.photoKey);
      return saved;
    },
  };
}
