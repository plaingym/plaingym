// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { households, members, type Transaction } from '@plaingym/db';
import { normalizePhone } from '@plaingym/shared/phone';
import { readGymSettings } from '../settings/settings.js';
import { readPhoneCountry } from './member-write.js';

/** IDs covered by the notice, and the consent holders to pass to MemberSms at send time. */
export interface SmsRecipientGroup {
  phoneE164: string; memberIds: string[]; householdIds: string[];
  consentMemberIds: string[]; consentHouseholdIds: string[];
}
function collector() {
  const groups = new Map<string, SmsRecipientGroup>();
  return {
    add(phoneE164: string, memberIds: string[], householdId: string, consent: 'member' | 'household', consentId: string) {
      const group = groups.get(phoneE164) ?? { phoneE164, memberIds: [], householdIds: [], consentMemberIds: [], consentHouseholdIds: [] };
      group.memberIds.push(...memberIds); group.householdIds.push(householdId);
      (consent === 'member' ? group.consentMemberIds : group.consentHouseholdIds).push(consentId);
      groups.set(phoneE164, group);
    },
    result() {
      return [...groups.values()].map(group => ({ ...group, memberIds: [...new Set(group.memberIds)].sort(), householdIds: [...new Set(group.householdIds)].sort(),
        consentMemberIds: [...new Set(group.consentMemberIds)].sort(), consentHouseholdIds: [...new Set(group.consentHouseholdIds)].sort() }))
        .sort((a, b) => a.phoneE164.localeCompare(b.phoneE164));
    },
  };
}

/** Billing notices: the consented billing phone wins; otherwise consented members at the billing email. */
export async function householdNoticePhones(tx: Transaction, gymId: string, householdIds: readonly string[]): Promise<SmsRecipientGroup[]> {
  if (!householdIds.length) return [];
  const homes = await tx.select({ id: households.id, email: households.email, phone: households.phone, phoneE164: households.phoneE164, at: households.smsNoticesConsentAt })
    .from(households).where(and(eq(households.gymId, gymId), inArray(households.id, [...householdIds])));
  const people = await tx.select({ id: members.id, householdId: members.householdId, email: members.email, phone: members.phone, phoneE164: members.phoneE164, at: members.smsNoticesConsentAt })
    .from(members).where(and(eq(members.gymId, gymId), inArray(members.householdId, homes.map(home => home.id)), isNull(members.anonymizedAt)));
  const country = await readPhoneCountry([...homes.map(home => home.phone), ...people.map(person => person.phone)],
    async () => (await readGymSettings(tx, gymId)).address.country);
  const current = (row: { phone: string | null; phoneE164: string | null }) =>
    row.phoneE164 !== null && normalizePhone(row.phone, country) === row.phoneE164;
  const groups = collector();
  for (const home of homes) {
    const covered = people.filter(person => person.householdId === home.id);
    if (home.phoneE164 && home.at && current(home)) groups.add(home.phoneE164, covered.map(person => person.id), home.id, 'household', home.id);
    else if (home.email?.trim()) for (const person of covered) {
      if (person.phoneE164 && person.at && current(person) && person.email?.trim().toLowerCase() === home.email.trim().toLowerCase())
        groups.add(person.phoneE164, covered.map(member => member.id), home.id, 'member', person.id);
    }
  }
  return groups.result();
}

/**
 * Class notices: each member's consented phone wins, otherwise their consented billing phone. As for billing notices,
 * a phone counts only while its stored number still normalizes to its E.164 form for the gym's country.
 */
export async function memberNoticePhones(tx: Transaction, gymId: string, memberIds: readonly string[]): Promise<SmsRecipientGroup[]> {
  if (!memberIds.length) return [];
  const people = await tx.select({ id: members.id, householdId: members.householdId, phone: members.phone, phoneE164: members.phoneE164, at: members.smsNoticesConsentAt })
    .from(members).where(and(eq(members.gymId, gymId), inArray(members.id, [...memberIds]), isNull(members.anonymizedAt)));
  if (!people.length) return [];
  const homes = await tx.select({ id: households.id, phone: households.phone, phoneE164: households.phoneE164, at: households.smsNoticesConsentAt })
    .from(households).where(and(eq(households.gymId, gymId), inArray(households.id, people.map(person => person.householdId))));
  const country = await readPhoneCountry([...people.map(person => person.phone), ...homes.map(home => home.phone)],
    async () => (await readGymSettings(tx, gymId)).address.country);
  const current = (row: { phone: string | null; phoneE164: string | null }) =>
    row.phoneE164 !== null && normalizePhone(row.phone, country) === row.phoneE164;
  const groups = collector();
  for (const person of people) {
    if (person.phoneE164 && person.at && current(person)) groups.add(person.phoneE164, [person.id], person.householdId, 'member', person.id);
    else {
      const home = homes.find(home => home.id === person.householdId);
      if (home?.phoneE164 && home.at && current(home)) groups.add(home.phoneE164, [person.id], home.id, 'household', home.id);
    }
  }
  return groups.result();
}
