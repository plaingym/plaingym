// SPDX-License-Identifier: AGPL-3.0-only
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

export const text = (key: string, values?: Record<string, string | number>) => t('announcements/screens:' + key, values);
export function Failure({ error, fallback }: { error: unknown; fallback: string }) {
  const reason = error instanceof ApiError && error.status === 409
    ? error.reason.find(value => value === 'disabled' || value === 'no_smtp') : undefined;
  return <Alert role="alert" className="space-y-3">
    <p>{text(reason ?? fallback)}</p>
    {reason && <Button asChild variant="outline"><a href="/admin/settings">{text(reason === 'disabled' ? 'goLiveSettings' : 'emailSettings')}</a></Button>}
  </Alert>;
}
