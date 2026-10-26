// SPDX-License-Identifier: AGPL-3.0-only
import { isDeepStrictEqual } from 'node:util';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Payments } from './index.js';

export interface Exchange {
  operation: string;
  input: unknown;
  output?: unknown;
  error?: { type: string; code?: string; statusCode?: number; payment_intent?: unknown };
}
export interface Tape { version: 1; gymId: string; exchanges: Exchange[] }
const paymentMethods = new Set<string>(['createCharge', 'confirmCharge', 'cancelCharge', 'findCharge', 'readPaymentObject',
  'listChangesSince', 'listRefunds', 'refund', 'createCheckout', 'expireCheckout', 'findCustomerByEmail', 'adoptCustomer', 'parseWebhook']);
/** Fixtures contain synthetic test-account data only. Credentials never enter the transport. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]');
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: [...value] };
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'lastResponse')
    .map(([key, item]) => [key, /^(secret|client_secret|authorization|api_key|number|cvc)$/i.test(key) ? '[redacted]' : redact(item)]));
  return value;
}
function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrate);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$date === 'string') return new Date(record.$date);
    if (Array.isArray(record.$bytes)) return new Uint8Array(record.$bytes as number[]);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, hydrate(item)]));
  }
  return value;
}
export class FixtureRecorder {
  readonly tape: Tape;
  constructor(gymId: string) { this.tape = { version: 1, gymId, exchanges: [] }; }
  async run<T>(operation: string, input: unknown, call: () => Promise<T>): Promise<T> {
    assertNoTransaction('payments.record');
    const exchange: Exchange = { operation, input: redact(input) };
    this.tape.exchanges.push(exchange);
    try { const result = await call(); exchange.output = redact(result); return result; }
    catch (error) {
      const record = error as Exchange['error'];
      const raw = error && typeof error === 'object' && 'raw' in error ? error.raw as Record<string, unknown> : undefined;
      const intent = record?.payment_intent ?? raw?.payment_intent;
      exchange.error = { type: record?.type ?? 'Error', ...(record?.code ? { code: record.code } : {}),
        ...(record?.statusCode ? { statusCode: record.statusCode } : {}),
        ...(intent ? { payment_intent: redact(intent) } : {}) };
      throw error;
    }
  }
  wrap(payments: Payments): Payments {
    return new Proxy(payments, { get: (target, property: keyof Payments) => {
      if (!paymentMethods.has(property)) return Reflect.get(target, property, target);
      const method = target[property];
      return (...args: unknown[]) => this.run(property, args, () => Reflect.apply(method, target, args));
    } });
  }
}
/** Strict replay fails closed on missing, reordered, or changed requests; it has no network fallback. */
export class Replay {
  #position = 0;
  constructor(readonly tape: Tape, gymId: string) {
    if (tape.version !== 1 || tape.gymId !== gymId) throw new Error('Fixture gym/version mismatch');
  }
  async run<T>(operation: string, input: unknown): Promise<T> {
    assertNoTransaction('payments.replay');
    const exchange = this.tape.exchanges[this.#position++];
    if (!exchange || exchange.operation !== operation || !isDeepStrictEqual(exchange.input, redact(input)))
      throw new Error('Fixture request mismatch at exchange ' + this.#position + ': ' + operation);
    if (exchange.error) throw Object.assign(new Error(exchange.error.type), hydrate(exchange.error));
    return hydrate(structuredClone(exchange.output)) as T;
  }
  assertConsumed(): void {
    if (this.#position !== this.tape.exchanges.length) throw new Error('Unconsumed fixture exchanges');
  }
}
export function replayPayments(tape: Tape, gymId: string): Payments {
  const replay = new Replay(tape, gymId);
  return new Proxy({} as Payments, { get: (_target, property: keyof Payments) =>
    paymentMethods.has(property) ? (...args: unknown[]) => replay.run(property, args) : undefined });
}
