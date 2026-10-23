// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { kioskStandingResponseSchema } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';

const known = new Set(['missing_waiver', 'inactive', 'billing']);
/** Staff see why the kiosk sends a member to the front desk; the kiosk itself never shows a reason. */
export function KioskStandingTab({ memberId }: ExtensionViewProps) {
  const query = useQuery({ queryKey: ['kiosk-standing', memberId], enabled: !!memberId, queryFn: async ({ signal }) => {
    const response = await fetch(`/api/kiosk/standing/${memberId}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Request failed');
    return kioskStandingResponseSchema.parse(await response.json()).data;
  } });
  if (query.isPending) return <p role="status">{t('kiosk/standing:loading')}</p>;
  if (query.isError) return <Alert role="alert">{t('kiosk/standing:error')}</Alert>;
  const standing = query.data;
  if (standing.status === 'ok') return <p>{t('kiosk/standing:ok')}</p>;
  return <div className="space-y-2"><p>{t('kiosk/standing:frontDesk')}</p><ul className="list-disc pl-6">{standing.reasons.map((code) =>
    <li key={code}>{known.has(code) ? t('kiosk/standing:reason.' + code) : t('kiosk/standing:reason.unknown', { code })}</li>)}</ul></div>;
}
