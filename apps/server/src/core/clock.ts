// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
export type { Clock } from '@plaingym/shared';

export const clock: Clock = { now: () => new Date() };

export class TestClock implements Clock {
  #time: number;
  constructor(initial: Date | string) {
    this.#time = this.#parse(initial);
  }
  now(): Date {
    return new Date(this.#time);
  }
  set(time: Date | string): void {
    this.#time = this.#parse(time);
  }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(this.#time + milliseconds).getTime())) {
      throw new Error('Invalid clock interval');
    }
    this.#time += milliseconds;
  }
  #parse(time: Date | string): number {
    const value = new Date(time).getTime();
    if (!Number.isFinite(value)) throw new Error('Invalid clock time');
    return value;
  }
}
