// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';
import { jsx } from 'hono/jsx/jsx-runtime';
import { button, inputClass, panel } from '../../public/pages/page.js';
/** Public form uses a fragment token, never interpolates it into markup, and submits JSON to the same origin.
 * The inline script carries the response's Content-Security-Policy nonce. It wears the core public pages' stylesheet and the
 * gym's colors; this file is one of that stylesheet's explicit sources (`public/links/styles.build.mjs`), so its classes compile. */
export function invitationPage(t: Translator, passwordRequired: boolean, nonce: string) {
  const script = `const form=document.getElementById('invite');const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;const fields=new FormData(form);try{const response=await fetch('/api/staff/invitations/accept',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,name:fields.get('name'),...(fields.has('password')?{password:fields.get('password')}:{})})});document.getElementById(response.ok?'success':'error').hidden=false;if(response.ok)form.hidden=true;}catch{document.getElementById('error').hidden=false;}finally{button.disabled=false;}});`;
  const field = (label: string, input: Record<string, unknown>) =>
    jsx('label', { for: input.id, class: 'block space-y-1', children: [label, jsx('input', { ...input, class: inputClass })] });
  return jsx('html', { lang: 'en', children: [
    jsx('head', { children: [jsx('meta', { charset: 'utf-8' }), jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), jsx('meta', { name: 'referrer', content: 'no-referrer' }), jsx('title', { children: t('staff/profiles:acceptInvitation') }),
      jsx('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }), jsx('link', { rel: 'stylesheet', href: '/public/pages/theme.css' })] }),
    jsx('body', { class: 'm-0 bg-background text-foreground', children: [jsx('main', { class: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-10', children: [
      jsx('header', { class: 'space-y-2', children: [jsx('h1', { class: 'text-2xl font-bold sm:text-3xl', children: t('staff/profiles:acceptInvitation') }), jsx('p', { children: t('staff/profiles:inviteDescription') })] }),
      jsx('form', { id: 'invite', class: panel, children: [
        field(t('staff/profiles:displayName'), { id: 'name', name: 'name', required: true, maxlength: 200, autocomplete: 'name' }),
        passwordRequired && field(t('staff/profiles:invitationPassword'), { id: 'password', name: 'password', type: 'password', required: true, minlength: 12, maxlength: 128, autocomplete: 'new-password' }),
        jsx('button', { type: 'submit', class: button, children: t('staff/profiles:acceptInvitation') }),
      ] }),
      jsx('p', { id: 'error', role: 'alert', hidden: true, children: t('staff/profiles:invitationError') }),
      jsx('p', { id: 'success', role: 'status', hidden: true, children: [t('staff/profiles:invitationAccepted'), ' ', jsx('a', { href: '/login', class: 'inline-flex min-h-11 items-center underline', children: t('staff/profiles:signIn') })] }),
      jsx('noscript', { children: t('staff/profiles:javascriptRequired') }),
      jsx('footer', { class: 'flex flex-wrap gap-3', children: jsx('a', { href: '/source', class: 'inline-flex min-h-11 items-center underline', children: t('staff/profiles:source') }) }),
    ] }),
    jsx('script', { nonce, dangerouslySetInnerHTML: { __html: script } })] }),
  ] });
}
