// SPDX-License-Identifier: AGPL-3.0-only
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';

/** Must match the server's Google callback path (`infra/auth/google.ts`). */
export const googleCallbackPath = '/api/auth/callback/google';
const label = (key: string) => t('auth/google:' + key);

/**
 * Google sign-in status, shown only when the install has a Google OAuth client. The client comes from the server's
 * configuration in every tenancy mode, so there is nothing for a gym owner to enter: the section explains what Google
 * sign-in does and shows this gym's redirect URI for the operator's OAuth client.
 */
export function GoogleLoginSettings() {
  const bootstrap = useBootstrap();
  if (!bootstrap.data?.login.google) return null;
  // The admin runs on the gym's canonical origin, the one Google returns to.
  const redirect = window.location.origin + googleCallbackPath;
  return <div className="space-y-3">
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    <p className="text-sm">{label('on')}</p>
    <p className="text-sm text-muted-foreground">{label('source')}</p>
    <div className="space-y-1">
      <p className="text-sm font-medium" id="google-redirect-label">{label('redirect')}</p>
      <code aria-labelledby="google-redirect-label" className="block break-all rounded-md bg-muted px-3 py-2 text-sm">{redirect}</code>
      <p className="text-sm text-muted-foreground">{label('redirectHelp')}</p>
    </div>
  </div>;
}
