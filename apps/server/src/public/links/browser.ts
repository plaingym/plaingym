// SPDX-License-Identifier: AGPL-3.0-only
/** Progressive enhancement, bundled separately for the browser by styles.build.mjs. */
export function linkBrowser() {
  const token = location.pathname.split('/')[2] ?? '';
  const purpose = document.body.dataset.purpose ?? '';
  const base = '/api/links/' + purpose.replaceAll('_', '-');
  const tablet = document.body.dataset.tablet === 'true';
  const feedback = document.getElementById('feedback')!;
  const message = (key: string) => document.querySelector<HTMLElement>('[data-message="' + key + '"]')?.textContent ?? '';
  const say = (key: string) => { feedback.textContent = message(key); };
  let activePage = true;
  const clear = () => { activePage = false; document.body.replaceChildren(); location.replace('/l/cleared'); };
  if (tablet && document.body.dataset.state === 'alreadyDone') { clear(); return; }
  let timeout: ReturnType<typeof setTimeout>;
  function touch() { clearTimeout(timeout); if (tablet) timeout = setTimeout(clear, 120_000); }
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, touch);
  touch();
  document.querySelector('[data-exit]')?.addEventListener('click', event => { event.preventDefault(); clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  window.addEventListener('pagehide', () => { activePage = false; if (tablet) document.body.replaceChildren(); });
  async function call(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-link-tablet': String(tablet) },
      body: JSON.stringify(body ?? {}) });
    if (response.status === 404 || response.status === 410) { location.reload(); throw new Error('unavailable'); }
    if (!response.ok || (path === '/complete' && response.status !== 200)) {
      // The customer state is explicit and contains no processor identifiers.
      const result = await response.json().catch(() => ({})) as { cardSetupUnavailable?: boolean };
      say(result.cardSetupUnavailable ? 'customerMissing' : response.status === 409 ? 'conflict' : 'failed');
      throw new Error('request failed');
    }
    return response.json() as Promise<{ data: Record<string, unknown> }>;
  }
  async function busy(element: HTMLButtonElement, run: () => Promise<void>, status = 'busy') {
    element.disabled = true;
    say(status);
    try { await run(); }
    catch { if (activePage && feedback.textContent === message(status)) say('failed'); }
    finally { element.disabled = false; }
  }
  function done() {
    if (tablet) return clear();
    location.reload();
  }
  document.querySelectorAll<HTMLButtonElement>('[data-checkout]').forEach(button => button.addEventListener('click', () => {
    void busy(button, async () => { const result = await call('/checkout');
      if (tablet) location.replace(String(result.data.url)); else location.assign(String(result.data.url)); });
  }));
  const complete = document.querySelector<HTMLButtonElement>('[data-complete]');
  complete?.addEventListener('click', () => { void busy(complete, async () => {
    const result = await call('/complete'); if (result.data.completed) done(); else say('incomplete');
  }); });
  // Returning from Stripe never asserts success. It asks the server whether webhook processing finished.
  if (complete && ['pay_invoice', 'update_card', 'onboarding'].includes(purpose)
    && new URL(location.href).searchParams.get('returned') === '1') {
    void busy(complete, async () => {
      for (let attempt = 0; attempt <= 5; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        if (!activePage) return;
        const result = await call('/complete');
        if (!activePage) return;
        if (result.data.completed) { done(); return; }
      }
      say('incomplete');
    }, 'confirming');
  }
  document.querySelectorAll<HTMLFormElement>('[data-waiver]').forEach(form => {
    const canvas = form.querySelector('canvas')!, ctx = canvas.getContext('2d')!;
    const file = form.querySelector<HTMLInputElement>('[name="image"]')!;
    let drawn = false, active = false, uploaded: Record<string, unknown> | undefined;
    function reset() { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; uploaded = undefined; file.value = ''; }
    const point = (event: PointerEvent) => { const bounds = canvas.getBoundingClientRect(); return [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height] as const; };
    canvas.addEventListener('pointerdown', event => {
      active = true; uploaded = undefined; file.value = ''; canvas.setPointerCapture(event.pointerId);
      ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#172524';
      ctx.beginPath(); ctx.moveTo(...point(event));
    });
    canvas.addEventListener('pointermove', event => { if (active) { ctx.lineTo(...point(event)); ctx.stroke(); drawn = true; } });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { active = false; });
    form.querySelector('[data-clear-signature]')?.addEventListener('click', reset);
    file.addEventListener('change', () => { uploaded = undefined; });
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
    const relationship = form.querySelector<HTMLInputElement>('[name="relationship"]')!;
    kind.addEventListener('change', () => { relationship.required = kind.value === 'guardian'; form.querySelector<HTMLElement>('[data-relationship]')!.hidden = !relationship.required; });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      if (!drawn && !file.files?.length) { say('signatureRequired'); return; }
      void busy(button, async () => {
        const member = purpose === 'onboarding' ? { memberId: form.dataset.member } : {};
        if (!uploaded) {
          const chosen = file.files?.[0];
          if (chosen && (chosen.size > 256 * 1024 || chosen.type !== 'image/png')) { say('signatureRequired'); return; }
          const dataUrl = chosen ? await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(chosen);
          }) : canvas.toDataURL('image/png');
          const result = await call('/signature-images', { ...member, pngBase64: dataUrl.split(',')[1] });
          uploaded = result.data;
        }
        const name = form.querySelector<HTMLInputElement>('[name="name"]')!.value.trim();
        await call(purpose === 'onboarding' ? '/waivers' : '', { ...member, ...uploaded,
          templateId: form.dataset.template, templateVersion: Number(form.dataset.version), consent: true,
          signer: kind.value === 'guardian' ? { kind: 'guardian', name, relationship: relationship.value.trim() } : { kind: 'self', name } });
        location.reload(); // Only the server's completed page may clear a member-signing tablet.
      });
    });
  });
}
