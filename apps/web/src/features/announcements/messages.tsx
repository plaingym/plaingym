// SPDX-License-Identifier: AGPL-3.0-only
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

export const text = (key: string, values?: Record<string, string | number>) => t('announcements/screens:' + key, values);
/** A refusal settles this request only; callers must preserve any earlier uncertain outcome. */
export function definiteRefusal(error: unknown) {
  return error instanceof ApiError && (error.status === 503 || (error.status >= 400 && error.status < 500 &&
    (error.status !== 409 || error.reason.some(reason => ['disabled', 'no_smtp', 'no_origin'].includes(reason)))));
}
export function Failure({ error, fallback, owner = false, retrySame = false }: { error: unknown; fallback: string; owner?: boolean; retrySame?: boolean }) {
  const reason = error instanceof ApiError && error.status === 409
    ? error.reason.find(value => value === 'disabled' || value === 'no_smtp' || value === 'no_origin') : undefined;
  return <Alert role="alert" className="space-y-3">
    <p>{text(retrySame ? 'sendError' : reason ?? (fallback === 'sendError' && definiteRefusal(error) ? 'sendRefused' : fallback))}</p>
    {(reason === 'disabled' || (owner && (reason === 'no_smtp' || reason === 'no_origin'))) &&
      <Button asChild variant="outline"><a href="/admin/settings" target="_blank" rel="noopener noreferrer">{text(reason === 'disabled' ? 'goLiveSettings' : reason === 'no_origin' ? 'addressSettings' : 'emailSettings')}</a></Button>}
  </Alert>;
}
