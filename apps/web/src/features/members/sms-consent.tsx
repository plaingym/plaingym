// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Household, Member } from '@plaingym/shared/contracts';
import * as c from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { memberRequest } from './api.js';

const text = (key: string, values?: Record<string, string | number>) => t('members/sms:' + key, values);
/** A choice is saved immediately; withdrawal takes one tap, independently for each kind. */
export function SmsConsentControls({ sms, gymName, staff = false, disabled = false, grantBlockedHint, onChange }: {
  sms: Household['sms'] | Member['sms']; gymName: string; staff?: boolean; disabled?: boolean; grantBlockedHint?: string;
  onChange(kind: 'notices' | 'announcements', consent: boolean): Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false), [error, setError] = useState(false);
  async function change(kind: 'notices' | 'announcements', consent: boolean) {
    if (disabled || saving || (consent && grantBlockedHint)) return;
    setSaving(true); setError(false);
    try { await onChange(kind, consent); } catch { setError(true); } finally { setSaving(false); }
  }
  const kinds = 'announcements' in sms ? ['notices', 'announcements'] as const : ['notices'] as const;
  const consentFor = (kind: 'notices' | 'announcements') => kind === 'notices' ? sms.notices : 'announcements' in sms ? sms.announcements : null;
  const showGrantHint = !!grantBlockedHint && kinds.some(kind => !consentFor(kind));
  return <section aria-label={text('title')} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-semibold">{text('title')}</h3>
    {!sms.phoneValid && <p className="text-sm text-muted-foreground">{text('invalidPhone')}</p>}
    {sms.phoneE164 && <p className="break-all text-sm">{sms.phoneE164}</p>}
    {kinds.map(kind => {
      const consent = consentFor(kind);
      return <div key={kind} className="space-y-2">
        <p className="text-sm">{text(kind, { gym: gymName })}</p>
        <p className="text-sm text-muted-foreground">{consent ? text('recorded', { at: new Date(consent.at).toLocaleString(), source: text('source_' + consent.source) }) : text('off')}</p>
        {staff && kind === 'announcements' && !consent ? <p className="text-sm text-muted-foreground">{text('memberOnly')}</p>
          : <Button type="button" variant="outline" className="w-full whitespace-normal sm:w-auto" disabled={disabled || saving || (!consent && (!sms.phoneValid || !!grantBlockedHint))}
            onClick={() => void change(kind, !consent)}>{text(consent ? 'withdraw_' + kind : staff ? 'verbal' : 'give_' + kind)}</Button>}
      </div>;
    })}
    {showGrantHint && <p className="text-sm text-muted-foreground">{grantBlockedHint}</p>}
    {staff && <p className="text-sm text-muted-foreground">{text('askFirst')}</p>}
    <p className="text-sm text-muted-foreground">{text('phoneChange')}</p>
    {error && <Alert variant="error" role="alert">{text('failed')}</Alert>}
  </section>;
}
export function StaffSmsConsent({ record, household = false }: { record: Member | Household; household?: boolean }) {
  const bootstrap = useBootstrap(), cache = useQueryClient();
  return <SmsConsentControls sms={record.sms} gymName={bootstrap.data?.gym.name ?? ''} staff
    onChange={async (kind, consent) => {
      await (household
        ? memberRequest(c.householdResponseSchema, `/api/households/${record.id}/sms-consent`, 'PUT', { consent, revision: record.revision })
        : memberRequest(c.memberResponseSchema, `/api/members/${record.id}/sms-consent`, 'PUT', { kind, consent, revision: record.revision }));
      await cache.invalidateQueries({ queryKey: ['members'] });
    }} />;
}
