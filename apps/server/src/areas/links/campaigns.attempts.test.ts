// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { credentialDisclosed, deliveryBlocked, type DeliveryHistory } from './campaigns.attempts.js';

const now = new Date('2026-11-15T12:00:00Z');
const event = (action: string, after: unknown = null, targetId = 'link'): DeliveryHistory[number] => ({
  targetId, action, after, occurredAt: now,
});

it('releases a definite non-send for disclosure and retry without releasing another link', () => {
  const history = [event('link_campaign.delivery_reserved', { reservation: 'attempt', occurrence: 'initial', mode: 'link' }),
    event('link_campaign.delivery_released', { reservation: 'attempt' })];
  expect(credentialDisclosed(history, 'link')).toBe(false);
  expect(deliveryBlocked(history, 'link', 'initial', now, 'UTC')).toBe(false);
  history[1] = event('link_campaign.delivery_released', { reservation: 'attempt' }, 'other-link');
  expect(credentialDisclosed(history, 'link')).toBe(true);
  expect(deliveryBlocked(history, 'link', 'initial', now, 'UTC')).toBe(true);
});

it.each(['link', undefined, 'manual', 'skip'] as const)('treats an interrupted %s reservation conservatively', mode => {
  const history = [event('link_campaign.delivery_reserved', { reservation: 'attempt', occurrence: 'initial', ...(mode ? { mode } : {}) })];
  expect(credentialDisclosed(history, 'link')).toBe(mode === 'link' || mode === undefined);
  expect(deliveryBlocked(history, 'link', 'initial', now, 'UTC')).toBe(true);
});

it.each(['link_campaign.delivery_sent', 'link_campaign.delivery_uncertain'])('preserves a credential with a recorded %s outcome', action => {
  expect(credentialDisclosed([event(action)], 'link')).toBe(true);
  expect(credentialDisclosed([event(action, null, 'other-link')], 'link')).toBe(false);
});
