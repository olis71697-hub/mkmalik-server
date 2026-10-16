/* Sign in / sign up — first thing the user sees on a fresh install. */

import { $, el, toast, svg, ICON } from '../util.js';
import { api } from '../api.js';

export function mountAuth({ onSubmit }) {
  let mode = 'login';
  let busy = false;

  const root = el('div', { class: 'auth', id: 'authScreen' });

  function render() {
    root.innerHTML = '';
    root.append(
      el('div', { class: 'auth-logo', text: '🎙️' }),
      el('h1', { class: 'auth-title', text: mode === 'login' ? 'Welcome back' : 'Create your account' }),
      el('p', {
        class: 'auth-sub',
        text: mode === 'login'
          ? 'Sign in to open a room, take a mic seat and talk to the world.'
          : 'Join in seconds — you get 1500 welcome coins to send your first gifts.',
      }),
    );

    const form = el('form', { class: 'auth-form' });

    if (mode === 'register') {
      form.append(field('Display name', 'text', 'displayName', 'What people will see', { maxlength: 24 }));
    }
    form.append(
      field('Username', 'text', 'username', 'letters, numbers, . or _', { maxlength: 20, autocomplete: 'username' }),
      field('Password', 'password', 'password', 'at least 6 characters', { autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
    );

    const submit = el('button', {
      class: 'btn btn--primary btn--block', type: 'submit', style: { marginTop: '6px', height: '48px' },
    }, mode === 'login' ? 'Sign in' : 'Create account');
    form.append(submit);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (busy) return;
      const fd = new FormData(form);
      const username = String(fd.get('username') || '').trim();
      const password = String(fd.get('password') || '');
      const displayName = String(fd.get('displayName') || '').trim() || username;

      if (!username || !password) return toast('Fill in every field', 'err');
      if (mode === 'register' && password.length < 6) return toast('Password needs 6+ characters', 'err');

      busy = true;
      submit.disabled = true;
      submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating…';
      try {
        await onSubmit(mode, username, password, displayName);
      } catch (e) {
        toast(e.message, 'err');
        busy = false;
        submit.disabled = false;
        submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      }
    });

    root.append(form);

    root.append(el('div', { class: 'auth-switch' },
      mode === 'login' ? 'New here? ' : 'Already have an account? ',
      el('button', {
        type: 'button',
        text: mode === 'login' ? 'Create an account' : 'Sign in',
        onclick: () => { mode = mode === 'login' ? 'register' : 'login'; render(); },
      }),
    ));

    root.append(el('div', {
      class: 'auth-demo',
      html: `Demo account — username <b>mkmalik</b> · password <b>demo1234</b>`,
    }));
  }

  function field(label, type, name, placeholder, attrs = {}) {
    const input = el('input', { type, name, placeholder, required: true, autocapitalize: 'none', autocorrect: 'off', ...attrs });
    return el('div', { class: 'field' }, el('label', { text: label, for: name }), input);
  }

  render();
  return root;
}
