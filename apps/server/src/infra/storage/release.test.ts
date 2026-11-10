// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { FakeUploads } from './index.js';
import { releaseFiles } from './release.js';
import { setLogSink } from '../../core/log.js';

it('resolves the gym store once and continues releasing other files after an error', async () => {
  const uploads = new FakeUploads('gym'), resolve = vi.fn(async () => uploads);
  const deleted = vi.spyOn(uploads, 'markDeleted').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
  const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
  try {
    await releaseFiles('gym', ['gym/one', 'gym/two'], resolve);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('gym');
    expect(deleted.mock.calls).toEqual([['gym/one'], ['gym/two']]);
    expect(lines).toHaveLength(1);
  } finally { setLogSink(previous); }
});

it('logs resolver failures without throwing and does not resolve a store for an empty release', async () => {
  const resolve = vi.fn().mockRejectedValue(new Error('unavailable'));
  const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
  try {
    await expect(releaseFiles('gym', ['gym/one'], resolve)).resolves.toBeUndefined();
    await releaseFiles('gym', [], resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(lines).toHaveLength(1);
  } finally { setLogSink(previous); }
});
