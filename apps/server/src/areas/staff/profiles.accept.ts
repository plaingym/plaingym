// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';
import { jsx } from 'hono/jsx/jsx-runtime';
/** Public form uses a fragment token, never interpolates it into markup, and submits JSON to the same origin. */
export function invitationPage(t: Translator, passwordRequired: boolean) {
  const script = `const form=document.getElementById('invite');const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;const fields=new FormData(form);try{const response=await fetch('/api/staff/invitations/accept',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,name:fields.get('name'),...(fields.has('password')?{password:fields.get('password')}:{})})});document.getElementById(response.ok?'success':'error').hidden=false;if(response.ok)form.hidden=true;}catch{document.getElementById('error').hidden=false;}finally{button.disabled=false;}});`;
  return jsx('html', { lang: 'en', children: [
    jsx('head', { children: [jsx('meta', { charset: 'utf-8' }), jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), jsx('meta', { name: 'referrer', content: 'no-referrer' }), jsx('title', { children: t('staff/profiles:acceptInvitation') })] }),
    jsx('body', { children: [jsx('main', { children: [
      jsx('h1', { children: t('staff/profiles:acceptInvitation') }), jsx('p', { children: t('staff/profiles:inviteDescription') }),
      jsx('form', { id: 'invite', children: [
        jsx('label', { children: [t('staff/profiles:displayName'), jsx('input', { name: 'name', required: true, maxlength: 200, autocomplete: 'name' })] }),
        passwordRequired && jsx('label', { children: [t('staff/profiles:invitationPassword'), jsx('input', { name: 'password', type: 'password', required: true, minlength: 12, maxlength: 128, autocomplete: 'new-password' })] }),
        jsx('button', { type: 'submit', children: t('staff/profiles:acceptInvitation') }),
      ] }),
      jsx('p', { id: 'error', role: 'alert', hidden: true, children: t('staff/profiles:invitationError') }),
      jsx('p', { id: 'success', role: 'status', hidden: true, children: [t('staff/profiles:invitationAccepted'), ' ', jsx('a', { href: '/login', children: t('staff/profiles:signIn') })] }),
      jsx('noscript', { children: t('staff/profiles:javascriptRequired') }),
    ] }), jsx('footer', { children: jsx('a', { href: '/source', children: t('staff/profiles:source') }) }),
    jsx('script', { dangerouslySetInnerHTML: { __html: script } })] }),
  ] });
}
