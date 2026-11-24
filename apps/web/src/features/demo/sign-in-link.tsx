// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useEffect, useRef, useState } from 'react';
import { demoSignInLinkResponse } from '@plaingym/shared/contracts';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { ApiError, createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { DemoSignInButtons, useDemoErrorCard, useDemoLogin, useDemoSandbox } from './notice.js';
const request = createJsonTransport();

/** LoginPage renders this only on the showcase. */
export function DemoShowcaseSignIn() {
  const { error } = useDemoLogin();
  const showHere = useDemoErrorCard();
  // Reveal the card's alert once per error occurrence (including an error that existed before mount),
  // without stealing focus from the Demo menu button when closing the menu shows the card again.
  const revealed = useRef(false);
  const revealError = error && showHere && !revealed.current;
  useEffect(() => { revealed.current = Boolean(error); }, [error, showHere]);
  return <div className="space-y-4">
    <p className="text-sm">{t('demo/demo:showcaseSignIn')}</p>
    <DemoSignInButtons />
    {error && showHere && <Alert variant="error" focusOnReveal={revealError}>{t('demo/demo:error')}</Alert>}
  </div>;
}

/** On `/login` in a sandbox, after "Email me a link": the link went to the demo outbox, and this opens it for the address
 * just entered, without switching to the owner. Elsewhere it renders nothing. */
export function DemoSignInLink({ email, navigate = (href: string) => window.location.assign(href) }: { email: string; navigate?: (href: string) => void }) {
  const sandbox = useDemoSandbox(), [pending, setPending] = useState(false), [error, setError] = useState<'missing' | 'failed' | 'limited'>();
  if (!sandbox) return null;
  async function open() {
    if (pending) return;
    setPending(true); setError(undefined);
    try {
      const { data } = parseResponse(demoSignInLinkResponse, await request('/api/demo/sign-in-link', { email }));
      // The contract allows only a sign-in path on this origin.
      navigate(data.href);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 404 ? 'missing' : failure instanceof ApiError && failure.status === 429 ? 'limited' : 'failed');
      setPending(false);
    }
  }
  return <div className="space-y-3">
    <p className="text-sm">{t('demo/demo:outboxHint')}</p>
    <Button type="button" className="w-full" disabled={pending} onClick={() => { void open(); }}>{t(pending ? 'demo/demo:openingLink' : 'demo/demo:openLink')}</Button>
    {error && <Alert variant="error" focusOnReveal>{t(error === 'missing' ? 'demo/demo:linkMissing' : error === 'limited' ? 'shell/shell:rateLimited' : 'demo/demo:linkFailed')}</Alert>}
  </div>;
}
