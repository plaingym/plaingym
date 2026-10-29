// SPDX-License-Identifier: AGPL-3.0-only
/** Plain browser JavaScript stays independent of server bundler helpers. No hydration. */
export const publicBrowserScript = String.raw`// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  const form = document.querySelector('[data-public-form]');
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
  let cached;
  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'failed');
    return response.json();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true; feedback.textContent = message('busy');
    try {
      const fields = new FormData(form), value = name => String(fields.get(name) || '');
      const common = { contact: { name: value('contactName'), email: value('email'), ...(value('phone') ? { phone: value('phone') } : {}) },
        member: { firstName: value('firstName'), lastName: value('lastName'), dateOfBirth: value('dateOfBirth') }, honeypot: value('honeypot') };
      if (form.dataset.publicForm === 'trial') await post('/api/public/trial', common);
      else {
        const waivers = [...form.querySelectorAll('[data-waiver]')];
        const signatures = await Promise.all(waivers.map(async (waiver, i) => {
          const file = fields.get('waiver-' + i + '-image');
          const pngBase64 = file instanceof File && file.size ? await readImage(file) : images.get(waiver.querySelector('canvas'))();
          if (!pngBase64) throw new Error('signatureRequired');
          return { templateId: waiver.dataset.template, templateVersion: Number(waiver.dataset.version), pngBase64 };
        }));
        const admission = { ...common, signatures }, key = JSON.stringify(admission);
        if (cached?.key !== key) cached = { key, data: (await post('/drop-in/signatures', admission)).data };
        await post('/api/public/drop-in', { ...common, waivers: cached.data.map((image, i) => ({ ...image,
          signer: value('waiver-' + i + '-kind') === 'guardian' ? { kind: 'guardian', name: value('waiver-' + i + '-name'), relationship: value('waiver-' + i + '-relationship') }
            : { kind: 'self', name: value('waiver-' + i + '-name') }, consent: true })) });
      }
      window.location.assign('/' + form.dataset.publicForm + '/received');
    } catch (error) {
      feedback.textContent = message(error instanceof Error ? error.message : 'failed') || message('failed');
      if (error instanceof Error && error.message === 'conflict') cached = undefined;
    } finally { submit.disabled = false; }
  });
})();`;
