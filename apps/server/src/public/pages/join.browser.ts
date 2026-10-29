// SPDX-License-Identifier: AGPL-3.0-only
/** Plain browser JavaScript, independent of server bundler helpers. No hydration: without it the native form posts files. */
export const joinBrowserScript = String.raw`// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  const form = document.querySelector('[data-join-form]');
  if (!form) return;
  const feedback = document.getElementById('feedback');
  const message = key => document.querySelector('[data-message="' + key + '"]')?.textContent || '';
  const images = new Map();
  for (const canvas of form.querySelectorAll('canvas')) {
    const ctx = canvas.getContext('2d');
    let drawing = false, ink = false;
    const clear = () => { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ink = false; };
    clear(); ctx.strokeStyle = '#111111'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    const point = e => { const b = canvas.getBoundingClientRect(); return [(e.clientX - b.left) * canvas.width / b.width, (e.clientY - b.top) * canvas.height / b.height]; };
    canvas.addEventListener('pointerdown', e => { feedback.textContent = ''; drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...point(e)); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...point(e)); ctx.stroke(); ink = true; });
    for (const event of ['pointerup', 'pointercancel']) canvas.addEventListener(event, () => { drawing = false; });
    canvas.closest('fieldset').querySelector('[data-clear-signature]').addEventListener('click', clear);
    images.set(canvas, () => ink ? canvas.toDataURL('image/png').split(',')[1] : null);
  }
  const readImage = file => new Promise((resolve, reject) => {
    if (file.type !== 'image/png' || file.size > 256 * 1024) { reject(new Error('signatureRequired')); return; }
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('failed')); reader.readAsDataURL(file);
  });
  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : response.status === 503 ? 'unavailable' : 'failed');
    return response.json();
  }
  // One admission per distinct set of details and signatures; a retry after a failed submission reuses it.
  let cached;
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true; feedback.textContent = message('busy');
    try {
      const fields = new FormData(form), value = name => String(fields.get(name) || '');
      const contact = { name: value('contactName'), email: value('email'), ...(value('phone') ? { phone: value('phone') } : {}) };
      const members = await Promise.all([...form.querySelectorAll('[data-member]')].map(async (fieldset, i) => ({
        member: { firstName: value('member-' + i + '-firstName'), lastName: value('member-' + i + '-lastName'), dateOfBirth: value('member-' + i + '-dateOfBirth') },
        signatures: await Promise.all([...fieldset.querySelectorAll('[data-waiver]')].map(async (waiver, j) => {
          const file = fields.get('waiver-' + i + '-' + j + '-image');
          const pngBase64 = file instanceof File && file.size ? await readImage(file) : images.get(waiver.querySelector('canvas'))();
          if (!pngBase64) throw new Error('signatureRequired');
          return { templateId: waiver.dataset.template, templateVersion: Number(waiver.dataset.version), pngBase64 };
        })),
      })));
      const admission = { planId: value('planId'), contact, members, honeypot: value('honeypot') }, key = JSON.stringify(admission);
      if (key.length > 1000 * 1000) throw new Error('tooLarge');
      if (cached?.key !== key) cached = { key, data: (await post('/join/signatures', admission)).data };
      await post('/api/public/join', { planId: value('planId'), contact, honeypot: value('honeypot'), members: members.map((person, i) => ({
        member: person.member, waivers: cached.data[i].map((image, j) => {
          const prefix = 'waiver-' + i + '-' + j;
          return { ...image, consent: true, signer: value(prefix + '-kind') === 'guardian'
            ? { kind: 'guardian', name: value(prefix + '-name'), relationship: value(prefix + '-relationship') } : { kind: 'self', name: value(prefix + '-name') } };
        }) })) });
      // The submission set an HttpOnly cookie naming only this pending join; payment continues from it.
      window.location.assign('/join/checkout');
    } catch (error) {
      feedback.textContent = message(error instanceof Error ? error.message : 'failed') || message('failed');
      if (error instanceof Error && error.message === 'conflict') cached = undefined;
    } finally { submit.disabled = false; }
  });
})();`;
