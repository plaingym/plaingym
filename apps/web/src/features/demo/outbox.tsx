// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { t } from '../../lib/i18n.js';
interface Message { id: string; recipient: string; subject: string; html: string; text: string; sentAt: string; }
/** TODO(CCR): use the generated client once demo contracts are shared. */
export function OutboxPage() {
  const [messages, setMessages] = useState<Message[]>([]), [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(false);
    void fetch('/api/demo/outbox' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), { credentials: 'same-origin', signal: abort.signal, redirect: 'error' })
      .then(async (response) => { if (!response.ok) throw new Error(); return await response.json() as { data: Message[]; next: string | null }; })
      .then((body) => { setMessages((current) => cursor ? [...current, ...body.data] : body.data); setNext(body.next); })
      .catch(() => { if (!abort.signal.aborted) setError(true); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [cursor]);
  return <section className="mx-auto max-w-4xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">{t('demo/demo:title')}</h1>
    <p>{t('demo/demo:banner')}</p><a className="underline" href="/admin">{t('demo/demo:back')}</a>
    {error && <p role="alert">{t('demo/demo:unavailable')}</p>}
    {loading && <p role="status">{t('demo/demo:loading')}</p>}
    {!loading && !error && messages.length === 0 && <p>{t('demo/demo:empty')}</p>}
    {messages.map((message) => <Card key={message.id}>
      <h2 className="text-lg font-semibold">{message.subject}</h2>
      <div className="space-y-3">
        <p>{t('demo/demo:recipient')}: {message.recipient}</p>
        <p>{t('demo/demo:sent')}: <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time></p>
        <pre className="whitespace-pre-wrap break-words font-sans">{message.text}</pre>
        <Button type="button" variant="outline" aria-expanded={preview === message.id} onClick={() => setPreview(preview === message.id ? null : message.id)}>{t('demo/demo:html')}</Button>
        {preview === message.id && <iframe title={message.subject} sandbox="" referrerPolicy="no-referrer" className="h-80 w-full border"
          srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:">' + message.html} />}
      </div>
    </Card>)}
    {next && <Button type="button" disabled={loading} onClick={() => setCursor(next)}>{t('demo/demo:more')}</Button>}
  </section>;
}
