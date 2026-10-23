// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { FixtureRecorder, Replay, type Tape } from './recording.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type ObjectData = { [key: string]: Json | undefined };
export interface ProviderRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  params?: ObjectData;
  idempotencyKey?: string;
}
export interface PaymentTransport { request(input: ProviderRequest): Promise<ObjectData> }
export function recordingTransport(transport: PaymentTransport, recorder: FixtureRecorder): PaymentTransport {
  return { request(input) { return recorder.run('stripe', input, () => transport.request(input)); } };
}
export function replayTransport(tape: Tape, gymId: string): PaymentTransport & { assertConsumed(): void } {
  const replay = new Replay(tape, gymId);
  return { request(input) { assertNoTransaction('payments.transport'); return replay.run('stripe', input); },
    assertConsumed() { replay.assertConsumed(); } };
}
