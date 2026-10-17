/* Wallet — balance, coin packages, mock-verified purchase, transactions. */

import { $, $$, el, toast, svg, ICON, compact, haptic } from '../util.js';
import { t, isBn, agoLabel } from '../i18n.js';
import { api } from '../api.js';

let mounted = false;

const REASON_LABEL = {
  welcome_bonus: isBn() ? 'ওয়েলকাম বোনাস' : 'Welcome bonus',
  daily_bonus: isBn() ? 'ডেইলি বোনাস' : 'Daily bonus',
  gift_sent: isBn() ? 'গিফট পাঠানো' : 'Gift sent',
  gift_received: isBn() ? 'গিফট পেয়েছেন' : 'Gift received',
  purchase: isBn() ? 'কয়েন কেনা' : 'Coin purchase',
  admin_topup: isBn() ? 'অ্যাডমিন টপ-আপ' : 'Admin top-up',
};

export function mountWallet(App) {
  if (mounted) return;
  mounted = true;

  const scroll = $('#walletScroll');
  let selectedPkg = null;
  let selectedMethod = 'bkash';
  let methods = [];

  async function load() {
    scroll.innerHTML = '';
    scroll.append(el('div', { class: 'spin' }));
    try {
      const [walletR, pkgR] = await Promise.all([api.wallet(), api.packages()]);
      const { wallet, transactions } = walletR;
      App.setWallet(wallet);
      methods = pkgR.methods || [];
      const packages = pkgR.packages || [];
      if (!selectedPkg && packages.length) selectedPkg = packages.find((p) => p.id === 'p1200') || packages[2] || packages[0];

      scroll.innerHTML = '';

      // hero
      scroll.append(el('div', { class: 'wallet-hero' },
        el('div', { class: 'wl', text: '🐼 ' + t('balance') }),
        el('div', { class: 'wv', html: svg(ICON.coin) + `<span>${compact(wallet.coins)}</span>` }),
        el('div', { class: 'wsub' },
          el('span', { html: `💎 <b>${compact(wallet.diamonds)}</b> ${t('diamonds')}` }),
          el('button', { class: 'btn btn--sm', style: { background: 'rgba(0,0,0,.25)', color: '#fff' }, text: '🎁 ' + t('claimBonus'), onclick: claimBonus }))));

      // packages
      scroll.append(el('div', { class: 'section-head' }, el('h2', { text: '🪙 ' + t('buyCoins') })));
      const grid = el('div', { class: 'pkg-grid' });
      packages.forEach((p, i) => {
        grid.append(el('button', {
          class: 'pkg' + (selectedPkg?.id === p.id ? ' is-selected' : '') + (i === 2 ? ' best' : ''),
          onclick: () => { selectedPkg = p; haptic(6); renderPkgs(); },
        },
          el('span', { class: 'pcoins', html: svg(ICON.coin) + ` ${compact(p.coins)}` }),
          p.bonus ? el('span', { class: 'pbonus', text: `+${compact(p.bonus)} ${t('bonus')}` }) : el('span', { style: { height: '14px' } }),
          el('span', { class: 'pprice', text: `৳${p.price}` })));
      });
      function renderPkgs() {
        [...grid.children].forEach((c, i) => c.classList.toggle('is-selected', packages[i]?.id === selectedPkg?.id));
        renderPay();
      }

      // payment methods
      scroll.append(el('div', { class: 'section-head' }, el('h2', { text: '💳 ' + t('paymentMethod') })));
      const payRow = el('div', { class: 'pay-methods' });
      methods.forEach((m) => {
        payRow.append(el('button', {
          class: selectedMethod === m.id ? 'is-selected' : '',
          onclick: () => { selectedMethod = m.id; haptic(6); [...payRow.children].forEach((c) => c.classList.remove('is-selected')); payRow.children[methods.findIndex((x) => x.id === m.id)].classList.add('is-selected'); },
        },
          el('span', { class: 'pm-emoji', text: m.emoji }),
          el('span', { text: m.label })));
      });

      const payBtn = el('button', { class: 'btn btn--gold btn--block', style: { marginTop: '12px' }, text: `${t('pay')} — ৳${selectedPkg?.price || 0}` });
      function renderPay() { payBtn.textContent = `${t('pay')} — ৳${selectedPkg?.price || 0}`; }
      payBtn.onclick = async () => {
        if (!selectedPkg) return;
        payBtn.disabled = true;
        payBtn.textContent = t('paymentProcessing');
        try {
          // demo gateway: a locally-generated reference the server can verify once
          const ref = 'MOCK-' + Math.random().toString(36).slice(2, 10).toUpperCase();
          const r = await api.purchase(selectedPkg.id, selectedMethod, ref);
          if (r.ok && r.status === 'success') {
            App.setWallet({ coins: r.coins });
            toast(`${t('paymentSuccess')} +${r.credited} 🪙`, 'ok');
            haptic(30);
            load();
            return;
          }
          throw new Error(r.error || t('paymentFailed'));
        } catch (e) {
          toast(e.message, 'err');
        }
        payBtn.disabled = false;
        renderPay();
      };

      const payWrap = el('div', {});
      payWrap.append(payRow, el('div', { class: 'center-note', text: t('mockPayNote'), style: { fontSize: '10.5px' } }), payBtn);
      scroll.append(grid, payWrap);

      // transactions
      scroll.append(el('div', { class: 'section-head' }, el('h2', { text: '🧾 ' + t('transactions') })));
      const card = el('div', { class: 'list-card', style: { padding: '2px 14px' } });
      if (!transactions?.length) {
        card.append(el('div', { class: 'empty-state', style: { padding: '20px' } }, el('p', { text: t('empty') })));
      } else {
        transactions.forEach((tx) => {
          const plus = tx.delta > 0;
          card.append(el('div', { class: 'tx-row' },
            el('div', { class: 'tx-icon', text: { purchase: '🪙', daily_bonus: '🎁', welcome_bonus: '🎉', gift_sent: '📤', gift_received: '🎁', admin_topup: '⬆️' }[tx.reason] || '•' }),
            el('div', { class: 'meta' },
              el('div', { class: 't1', text: REASON_LABEL[tx.reason] || tx.reason }),
              el('div', { class: 't2', text: agoLabel(tx.createdAt) })),
            el('span', { class: 'amt ' + (plus ? 'is-plus' : 'is-minus'), text: (plus ? '+' : '') + compact(tx.delta) })));
        });
      }
      scroll.append(card);
      scroll.append(el('div', { style: { height: '20px' } }));
    } catch (e) {
      scroll.innerHTML = '';
      scroll.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-emoji', text: '📡' }), el('p', { text: e.message })));
    }
  }

  async function claimBonus() {
    try {
      const r = await api.dailyBonus();
      App.setWallet({ coins: r.coins });
      toast(`${t('bonusClaimed')} +${r.awarded} 🪙`, 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  App.events.on('route', (name) => { if (name === 'wallet') load(); });
  App.events.on('wallet-refresh', () => { if (App.current === 'wallet') load(); });
  load();
}
