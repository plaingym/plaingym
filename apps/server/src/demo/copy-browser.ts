// SPDX-License-Identifier: AGPL-3.0-only
/** Server-rendered intake pages reuse the same destination-host exchange as the SPA. */
export const publicCopyScript = String.raw`async function demoCopyPrompt(response) {
  if (response.status !== 403) return false;
  const reason = (await response.clone().json().catch(() => null))?.error?.details?.reason;
  if (!Array.isArray(reason) || !reason.includes('demo_showcase_read_only')) return false;
  let dialog = document.querySelector('[data-demo-copy]');
  if (dialog) { dialog.showModal(); return true; }
  dialog = document.createElement('dialog'); dialog.dataset.demoCopy = '';
  dialog.className = 'rounded-xl border border-border bg-background p-4 sm:p-6';
  const title = document.createElement('h2'); title.textContent = 'This demo is shared. Make your own copy to change things.';
  title.className = 'text-lg font-semibold';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Make my own copy';
  button.className = 'min-h-11 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.className = 'min-h-11 px-4 py-3'; close.addEventListener('click', () => dialog.close());
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const page = ['/join', '/trial', '/drop-in'].includes(location.pathname) ? location.pathname : '/demo';
      const request = async (path, body) => {
        const result = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
        if (!result.ok) throw new Error('Copy failed');
        return (await result.json()).data;
      };
      let role = 'student';
      try { const saved = sessionStorage.getItem('demo-role'); if (['owner', 'coach', 'student'].includes(saved)) role = saved; } catch {}
      try {
        const current = (await request('/api/auth/bootstrap')).session;
        if (current?.roles?.includes('owner') || current?.roles?.includes('admin')) role = 'owner';
        else if (current?.roles?.includes('coach')) role = 'coach';
        else if (current?.member) role = 'student';
      } catch {}
      let data = await request('/api/demo/sandboxes', { role, page });
      const deadline = Date.now() + 3600000;
      while (data.pending) {
        if (Date.now() >= deadline) throw new Error('Copy timed out');
        status.textContent = 'Your place in line: ' + data.position;
        await new Promise(resolve => setTimeout(resolve, 2000));
        data = await request('/api/demo/creations/' + encodeURIComponent(data.ticket));
      }
      const destination = new URL('/demo', data.origin);
      destination.hash = new URLSearchParams({ copyToken: data.handoffToken }).toString();
      location.assign(destination.href);
    } catch { status.textContent = 'We could not create your copy. Please try again.'; button.disabled = false; }
  });
  dialog.append(title, button, status, close); document.body.append(dialog); dialog.showModal();
  return true;
}`;
