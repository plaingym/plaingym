// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { smtpPortMismatch } from '../../lib/integration-setup.js';

export function SmtpPortHint({ text }: { text: (kind: 'tls' | 'starttls') => string }) {
  const line = useRef<HTMLParagraphElement>(null);
  const [kind, setKind] = useState<ReturnType<typeof smtpPortMismatch>>(null);
  useEffect(() => {
    const form = line.current?.closest('form');
    const port = form?.elements.namedItem('port'), secure = form?.elements.namedItem('secure');
    if (!form || !(port instanceof HTMLInputElement) || !(secure instanceof HTMLInputElement)) return;
    const update = () => setKind(smtpPortMismatch(Number(port.value), secure.checked));
    update();
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    return () => {
      form.removeEventListener('input', update);
      form.removeEventListener('change', update);
    };
  }, []);
  return <p ref={line} aria-live="polite" className="text-sm">{kind ? text(kind) : null}</p>;
}
