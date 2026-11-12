// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { downloadBackupKey } from '../../lib/integration-setup.js';
import { Button } from '../../components/ui/button.js';
import { t } from '../../lib/i18n.js';

const label = (key: string) => t('setup/backup-key:' + key);
/**
 * A new backup key pair, shown once (the setup wizard and Settings → Backups): the private key, labelled as the secret
 * and wrapped so its start is never cut off, with Copy and Download right below it; then the public key, labelled as
 * safe to share. The key lives only in this component's props: it is never stored in the browser.
 */
export function BackupKeyPanel({ privateKey, publicKey, idPrefix, closingReplaces = false }: {
  privateKey: string; publicKey: string; idPrefix: string;
  /** The wizard makes a new key when reopened before the key is confirmed, so it says so. */
  closingReplaces?: boolean;
}) {
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null), keyBox = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 4000);
    return () => clearTimeout(timer);
  }, [copied]);
  /** Where the clipboard is refused (an insecure origin, a denied permission), selects the key so it can be copied by hand. */
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('No clipboard');
      await navigator.clipboard.writeText(privateKey);
      setCopied('copied');
    } catch {
      const box = keyBox.current, selection = window.getSelection();
      if (box && selection) { const range = document.createRange(); range.selectNodeContents(box); selection.removeAllRanges(); selection.addRange(range); }
      setCopied('selected');
    }
  };
  return <div className="grid min-w-0 gap-3">
    <p className="text-sm font-medium">{label('warning')}</p>
    <div role="group" aria-labelledby={idPrefix + '-private-label'} className="grid min-w-0 gap-2">
      <p id={idPrefix + '-private-label'} className="text-sm font-semibold">{label('privateLabel')}</p>
      <pre ref={keyBox} className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-sm">{privateKey}</pre>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" variant="outline" onClick={() => void copy()}>{label('copy')}</Button>
        <Button type="button" variant="outline" onClick={() => downloadBackupKey(privateKey)}>{label('download')}</Button>
      </div>
      <p role="status" className="min-h-5 text-sm">{copied ? label(copied) : ''}</p>
    </div>
    <div role="group" aria-labelledby={idPrefix + '-public-label'} className="grid min-w-0 gap-1">
      <p id={idPrefix + '-public-label'} className="text-sm font-semibold">{label('publicLabel')}</p>
      <p className="break-all font-mono text-sm text-muted-foreground">{publicKey}</p>
    </div>
    {closingReplaces && <p className="text-sm text-muted-foreground">{label('replaced')}</p>}
  </div>;
}
/** The separate "Confirm you saved the key" section: its own heading and hint, so it doesn't read as a request for a second key. */
export function ConfirmKeySection({ idPrefix, children }: { idPrefix: string; children: ReactNode }) {
  return <section aria-labelledby={idPrefix + '-confirm-title'} className="grid min-w-0 gap-3 rounded-md border border-border p-3 sm:p-4">
    <h3 id={idPrefix + '-confirm-title'} className="text-base font-semibold">{label('confirmTitle')}</h3>
    <p className="text-sm text-muted-foreground">{label('confirmHint')}</p>
    {children}
  </section>;
}
/** The confirmation field's label and the button that checks it, named for what it checks. */
export const confirmKeyLabels = { field: () => label('pasteLabel'), submit: () => label('check'), checking: () => label('checking'), mismatch: () => label('mismatch') };
