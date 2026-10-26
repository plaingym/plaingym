// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { Dialog } from '../../components/ui/dialog.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states.js';
import { t } from '../../lib/i18n.js';
import { outboxResponse } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
type Message = ReturnType<typeof outboxResponse.parse>['data'][number];
export function OutboxPage() {
  const [messages, setMessages] = useState<Message[]>([]), [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(false);
    void api.GET('/api/demo/outbox', { params: { query: { limit: 30, ...(cursor ? { before: cursor } : {}) } }, signal: abort.signal })
      .then((result) => { if (!result.response.ok) throw new Error(); return outboxResponse.parse(result.data); })
      .then((body) => { setMessages((current) => cursor ? [...current, ...body.data] : body.data); setNext(body.next); })
      .catch(() => { if (!abort.signal.aborted) setError(true); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [cursor, retry]);
  const selected = messages.find((message) => message.id === preview);
  return <Page className="max-w-4xl">
    <PageHeader title={t('demo/demo:title')} description={t('demo/demo:banner')} />
    <a className="inline-flex min-h-11 items-center underline" href="/admin">{t('demo/demo:back')}</a>
    {error && <ErrorState message={t('demo/demo:unavailable')} onRetry={() => setRetry((value) => value + 1)} />}
    {loading && <LoadingState label={t('demo/demo:loading')} />}
    {!loading && !error && messages.length === 0 && <EmptyState title={t('demo/demo:empty')} />}
    {messages.map((message) => <Card key={message.id}>
      <h2 className="break-words text-lg font-semibold">{message.subject}</h2>
      <div className="space-y-3">
        <p className="break-words">{t('demo/demo:recipient')}: {message.recipient}</p>
        <p>{t('demo/demo:sent')}: <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time></p>
        <pre className="whitespace-pre-wrap break-words font-sans">{message.text}</pre>
        <Button type="button" variant="outline" onClick={() => setPreview(message.id)}>{t('demo/demo:html')}</Button>
      </div>
    </Card>)}
    {next && <Button type="button" disabled={loading} onClick={() => setCursor(next)}>{t('demo/demo:more')}</Button>}
    {selected && <Dialog title={selected.subject} closeLabel={t('demo/demo:closePreview')} onClose={() => setPreview(null)} size="wide">
      <iframe title={selected.subject} sandbox="" referrerPolicy="no-referrer" className="h-[60dvh] w-full border border-border"
        srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:">' + selected.html} />
    </Dialog>}
  </Page>;
}
