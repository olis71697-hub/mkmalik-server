/* Auth screens — onboarding, login, register, phone OTP, password reset. */

import { $, $$, el, toast, svg, ICON, haptic } from '../util.js';
import { t } from '../i18n.js';
import { api, session } from '../api.js';

const field = (label, wrap) => el('div', { class: 'field' },
  el('label', { text: label }),
  wrap);

/** icon + input inside the standard field wrapper */
const inputField = (icon, type, placeholder, extra = {}) => {
  const i = el('input', { class: 'input', type, placeholder, ...extra });
  const wrap = el('div', { class: 'input-wrap' }, svg(ICON[icon]), i);
  return { wrap, input: i };
};

/* ═════════════════ onboarding ═════════════════ */
export function mountOnboarding(App, onDone) {
  const root = $('#onboarding');
  root.innerHTML = '';

  const SLIDES = [
    { emoji: '🐼', t: t('ob1t'), d: t('ob1d') },
    { emoji: '🎁', t: t('ob2t'), d: t('ob2d') },
    { emoji: '👑', t: t('ob3t'), d: t('ob3d') },
  ];
  let idx = 0;

  const dots = el('div', { class: 'onb-dots' }, SLIDES.map((_, i) => el('i', { class: i === 0 ? 'is-on' : '' })));
  const art = el('div', { class: 'onb-art' });
  const btnNext = el('button', { class: 'btn btn--primary btn--block', text: t('next'), onclick: next });
  const btnSkip = el('button', { class: 'btn btn--ghost btn--block', style: { marginTop: '8px' }, text: t('skip'), onclick: done });

  function render() {
    const s = SLIDES[idx];
    art.innerHTML = '';
    art.append(
      el('div', { class: 'emoji', text: s.emoji }),
      el('h2', { text: s.t }),
      el('p', { text: s.d }),
    );
    [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i === idx));
    btnNext.textContent = idx === SLIDES.length - 1 ? t('start') : t('next');
  }
  function next() {
    haptic(8);
    if (idx < SLIDES.length - 1) { idx++; render(); } else done();
  }
  function done() { onDone(); }

  root.append(el('div', { class: 'onb' }, art, dots, btnNext, btnSkip));
  render();
}

/* ═════════════════ auth (login / register / otp / reset) ═════════════════ */
export function mountAuth(App, onSignedIn) {
  const root = $('#authScreen');
  root.innerHTML = '';

  let mode = 'login'; // login | register | phone | forgot | reset

  const card = el('div', { class: 'auth-card' });
  const body = el('div', { class: 'auth-wrap' },
    el('div', { class: 'auth-logo' },
      el('img', { src: 'icons/icon-512.png', alt: 'Panda Voice' }),
      el('h1', { html: 'Panda <span style="color:var(--brand-2)">Voice</span>' }),
      el('p', { text: t('tagline') })),
    card);

  root.append(body);

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.textContent = on ? '…' : label;
  }

  function switchTo(next) { mode = next; render(); }

  /* ---- login ---- */
  function renderLogin() {
    const u = inputField('user', 'text', t('username'), { autocomplete: 'username' });
    const p = inputField('lock', 'password', t('password'), { autocomplete: 'current-password' });
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('login') });

    const googleBtn = el('button', { class: 'btn btn--google btn--block', html: svg(ICON.google) + ' ' + t('signInGoogle') });
    const phoneBtn = el('button', { class: 'btn btn--ghost btn--block', text: '📱 ' + t('signInPhone') });

    btn.onclick = async () => {
      busy(btn, true, t('login'));
      try {
        const r = await api.login(u.input.value.trim(), p.input.value);
        onSignedIn({ user: r.user, token: r.token });
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('login'));
    };
    p.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });

    googleBtn.onclick = () => mountGoogle(App, onSignedIn, switchTo);
    phoneBtn.onclick = async () => {
      // honest gate: phone login needs a real SMS gateway on the server
      try {
        const h = await api.health();
        if (!h.features?.sms) {
          toast('SMS গেটওয়ে সংযোগ করা হয়নি (SMS_API_URL) — ফোন দিয়ে লগইন এখন চালু নেই। ইউজারনেম/পাসওয়ার্ড ব্যবহার করুন', 'err');
          return;
        }
      } catch (_) { /* the request itself will explain if the server is gone */ }
      switchTo('phone');
    };

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 14px', fontSize: '20px' }, text: t('login') }),
      field(t('username'), u.wrap),
      field(t('password'), p.wrap),
      el('div', { style: { textAlign: 'right', margin: '-6px 0 14px' } },
        el('button', { style: { color: 'var(--brand-2)', fontWeight: 700, fontSize: '12.5px' }, text: t('forgotPw'), onclick: () => switchTo('forgot') })),
      btn,
      el('div', { class: 'auth-divider', text: 'অথবা' }),
      googleBtn,
      phoneBtn,
      el('div', { class: 'auth-alt' },
        el('span', { text: t('noAccount') + ' ' }),
        el('button', { text: t('register'), onclick: () => switchTo('register') })),
    );
  }

  /* ---- register ---- */
  function renderRegister() {
    const n = inputField('user', 'text', t('displayName'));
    const u = inputField('user', 'text', t('username'), { autocomplete: 'username' });
    const p = inputField('lock', 'password', t('password'), { autocomplete: 'new-password' });
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('createAccount') });

    const terms = el('input', { type: 'checkbox' });
    const termsRow = el('label', { class: 'terms-check' }, terms,
      el('span', { html: t('acceptTerms') + ' (<a href="#" data-terms>Terms</a> · <a href="#" data-privacy>Privacy</a>)' }));
    termsRow.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      import('./extra.js').then(({ openPage }) =>
        openPage.terms(App, a.dataset.terms !== undefined ? 'terms' : 'privacy'));
    }));

    btn.onclick = async () => {
      if (!terms.checked) { toast(t('acceptTerms'), 'err'); return; }
      busy(btn, true, t('createAccount'));
      try {
        const r = await api.register(u.input.value.trim(), p.input.value, n.input.value.trim());
        toast(`${t('welcome')}, ${r.user.displayName}! +${r.welcomeCoins} 🪙`, 'ok');
        onSignedIn({ user: r.user, token: r.token });
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('createAccount'));
    };

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 14px', fontSize: '20px' }, text: t('createAccount') }),
      field(t('displayName'), n.wrap),
      field(t('username'), u.wrap),
      field(t('password'), p.wrap),
      termsRow,
      btn,
      el('div', { class: 'auth-alt' },
        el('span', { text: t('haveAccount') + ' ' }),
        el('button', { text: t('login'), onclick: () => switchTo('login') })),
    );
  }

  /* ---- phone OTP ---- */
  let otpState = { phone: '', devCode: '', name: '' };

  function renderPhone() {
    const ph = inputField('phone', 'tel', '01XXXXXXXXX', { inputmode: 'numeric' });
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('sendOtp') });

    btn.onclick = async () => {
      const phone = ph.input.value.trim();
      if (phone.replace(/\D/g, '').length < 10) { toast(t('phone') + ' — ' + t('error'), 'err'); return; }
      busy(btn, true, t('sendOtp'));
      try {
        const r = await api.otpRequest(phone);
        otpState.phone = r.phone;
        otpState.devCode = r.devCode || '';
        otpState.exists = r.exists;
        switchTo('otp');
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('sendOtp'));
    };

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 14px', fontSize: '20px' }, text: t('signInPhone') }),
      field(t('phone'), ph.wrap),
      btn,
      el('div', { class: 'auth-alt' },
        el('button', { text: '← ' + t('login'), onclick: () => switchTo('login') })),
    );
  }

  function renderOtp() {
    const cd = inputField('shield', 'text', '------', { inputmode: 'numeric', maxlength: '6' });
    let nameInput = null;
    if (!otpState.exists) {
      nameInput = inputField('user', 'text', t('displayName'));
    }
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('verify') });
    let timer = 300;
    const timerEl = el('div', { class: 'otp-timer' });

    const tick = setInterval(() => {
      timer--;
      if (timer <= 0) { clearInterval(tick); timerEl.textContent = t('otpDevNote'); return; }
      timerEl.textContent = `⏱ ${Math.floor(timer / 60)}:${String(timer % 60).padStart(2, '0')}`;
    }, 1000);

    const note = otpState.devCode
      ? el('div', { class: 'otp-note' }, el('span', { text: 'ℹ️' }),
          el('div', {}, el('div', { text: t('otpDevNote') }),
            el('div', { class: 'otp-code-display', text: otpState.devCode })))
      : null;

    btn.onclick = async () => {
      busy(btn, true, t('verify'));
      try {
        const r = await api.otpVerify(otpState.phone, cd.input.value.trim(), nameInput ? nameInput.input.value.trim() : '');
        if (r.welcomeCoins) toast(`${t('welcome')}! +${r.welcomeCoins} 🪙`, 'ok');
        clearInterval(tick);
        onSignedIn({ user: r.user, token: r.token });
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('verify'));
    };
    cd.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 6px', fontSize: '20px' }, text: t('verify') }),
      el('p', { style: { color: 'var(--text-dim)', fontSize: '12.5px', margin: '0 0 12px' }, text: otpState.phone }),
      note || el('div'),
      nameInput ? field(t('displayName'), nameInput.wrap) : el('div'),
      field(t('otpCode'), cd.wrap),
      timerEl,
      btn,
      el('div', { class: 'auth-alt' },
        el('button', { text: t('resend'), onclick: () => switchTo('phone') }),
        el('span', { text: ' · ' }),
        el('button', { text: '← ' + t('login'), onclick: () => { clearInterval(tick); switchTo('login'); } })),
    );
    cd.input.focus();
  }

  /* ---- forgot / reset ---- */
  function renderForgot() {
    const u = inputField('user', 'text', t('username') + ' / ' + t('userId'));
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('sendOtp') });

    btn.onclick = async () => {
      busy(btn, true, t('sendOtp'));
      try {
        const r = await api.forgot(u.input.value.trim());
        if (r.devCode) {
          otpState.resetUser = u.input.value.trim();
          otpState.devCode = r.devCode;
          switchTo('reset');
        } else {
          toast(t('resetSent'), 'ok');
        }
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('sendOtp'));
    };

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 14px', fontSize: '20px' }, text: t('resetPw') }),
      field(t('username'), u.wrap),
      btn,
      el('div', { class: 'auth-alt' }, el('button', { text: '← ' + t('login'), onclick: () => switchTo('login') })),
    );
  }

  function renderReset() {
    const cd = inputField('shield', 'text', '------', { inputmode: 'numeric', maxlength: '6' });
    const p1 = inputField('lock', 'password', t('newPassword'));
    const btn = el('button', { class: 'btn btn--primary btn--block', text: t('save') });

    btn.onclick = async () => {
      busy(btn, true, t('save'));
      try {
        await api.reset(otpState.resetUser, cd.input.value.trim(), p1.input.value);
        toast(t('passwordChanged'), 'ok');
        switchTo('login');
      } catch (e) { toast(e.message, 'err'); }
      busy(btn, false, t('save'));
    };

    card.innerHTML = '';
    card.append(
      el('h2', { style: { margin: '0 0 6px', fontSize: '20px' }, text: t('resetPw') }),
      el('p', { style: { color: 'var(--text-dim)', fontSize: '12.5px', margin: '0 0 12px' }, text: t('resetSent') }),
      otpState.devCode ? el('div', { class: 'otp-note' },
        el('span', { text: 'ℹ️' }),
        el('div', {}, el('div', { text: t('otpDevNote') }),
          el('div', { class: 'otp-code-display', text: otpState.devCode }))) : null,
      field(t('otpCode'), cd.wrap),
      field(t('newPassword'), p1.wrap),
      btn,
      el('div', { class: 'auth-alt' }, el('button', { text: '← ' + t('login'), onclick: () => switchTo('login') })),
    );
  }

  render();
  function render() {
    if (mode === 'login') renderLogin();
    else if (mode === 'register') renderRegister();
    else if (mode === 'phone') renderPhone();
    else if (mode === 'otp') renderOtp();
    else if (mode === 'forgot') renderForgot();
    else if (mode === 'reset') renderReset();
  }
}

/* ═════════════════ Google Sign-In (only when the server is configured) ═════ */
function mountGoogle(App, onSignedIn, back) {
  import('../runtime.js').then(async ({ apiBase }) => {
    try {
      const res = await fetch(apiBase() + '/health');
      const health = await res.json();
      if (!health.features?.google) {
        toast('Google Sign-In সার্ভারে কনফিগার করা হয়নি (GOOGLE_CLIENT_ID) — README দেখুন', 'err');
        back('login');
        return;
      }
      // Load GIS only when we know it will work
      const g = document.createElement('script');
      g.src = 'https://accounts.google.com/gsi/client';
      g.onload = () => {
        if (!window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: health.googleClientId || '',
          callback: async (resp) => {
            try {
              const r = await api.google(resp.credential);
              onSignedIn({ user: r.user, token: r.token });
            } catch (e) { toast(e.message, 'err'); }
          },
        });
        window.google.accounts.id.prompt();
      };
      document.head.append(g);
    } catch (_) {
      toast('Google Sign-In এখন অনুপলব্ধ', 'err');
    }
  });
}
