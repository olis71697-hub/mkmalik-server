'use strict';

/**
 * Panda Voice — server-side content safety filter.
 *
 * Voice-chat apps live or die by the tone of their rooms. This module keeps
 * unambiguous profanity and slurs (Bengali script, romanized Bengali and
 * English) out of room chat, DMs, room titles and profile text — decided on
 * the SERVER, so no client can bypass it.
 *
 * Design rules:
 *  • the list is deliberately short and unambiguous — false positives are
 *    worse than false negatives
 *  • evasions are handled by normalisation: leetspeak (f.u.c.k, sh1t, b*nch0d),
 *    zero-width characters, repeated letters (fuuuck), mixed separators
 *  • repeated violations add up to a temporary chat timeout (spam prevention)
 *  • the whole filter can be disabled per deployment with CHAT_FILTER=off
 */

const config = require('./config');

// ---- unambiguous terms only ------------------------------------------------
// [term, script]  script: 'bn' → substring match, 'en' → word-boundary match
const BANNED = [
  // English
  ['fuck', 'en'], ['fucking', 'en'], ['fucker', 'en'], ['motherfucker', 'en'],
  ['shit', 'en'], ['bitch', 'en'], ['asshole', 'en'], ['bastard', 'en'],
  ['cunt', 'en'], ['whore', 'en'], ['slut', 'en'], ['dickhead', 'en'],
  // romanized Bengali
  ['magi', 'en'], ['khanki', 'en'], ['chuda', 'en'], ['chudi', 'en'],
  ['chudir', 'en'], ['chodai', 'en'], ['banchod', 'en'], ['bnchod', 'en'],
  ['bhosdi', 'en'], ['bhandro', 'en'], ['gandu', 'en'], ['lavda', 'en'],
  ['lauda', 'en'], ['lauda ', 'en'], ['haramjadi', 'en'],
  // Bengali script
  ['মাগি', 'bn'], ['মাগী', 'bn'], ['খানকি', 'bn'], ['খানকী', 'bn'],
  ['চুদি', 'bn'], ['চুদা', 'bn'], ['চোদা', 'bn'], ['চোদন', 'bn'],
  ['চুদাচুদি', 'bn'], ['বাঞ্চোদ', 'bn'], ['বানচোদ', 'bn'],
  ['ভোসড়া', 'bn'], ['ভোসদি', 'bn'], ['ভাঁসড়া', 'bn'],
  ['গান্ডু', 'bn'], ['গাঁদু', 'bn'],
  ['লাভড়া', 'bn'], ['লৌড়া', 'bn'], ['লুঙ্ডি', 'bn'],
  ['বেশ্যা', 'bn'], ['বেশ্য', 'bn'], ['হারামজাদা', 'bn'], ['হারামজাদী', 'bn'],
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't' };

/**
 * Canonical form used for matching:
 *  lowercase → strip zero-width chars → de-leet ASCII → every run of
 *  non-letters (anything but a-z and Bengali \u0980-\u09FF) becomes a space →
 *  collapse 3+ repeats to one (fuuuck → fuck).
 */
function normalize(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  s = s.replace(/[0134578@$!+]/g, (c) => LEET[c] || c);
  s = s.replace(/[^a-z\u0980-\u09ff]+/g, ' ');
  s = s.replace(/([a-z\u0980-\u09ff])\1{2,}/g, '$1');
  s = s.trim();
  if (!s) return s;

  // separator evasion: "f u c k", "b *nch0d" style splitting
  const tokens = s.split(' ');
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1) { run.push(t); continue; }
    flush();
    out.push(t);
  }
  flush();
  return out.join(' ');
}

const PREPARED = BANNED.map(([term, script]) => ({ term: normalize(term), script, short: script === 'en' && term.length <= 4 }));

/**
 * Check a piece of user text.
 * @returns {{ok:true}|{ok:false, reason:string, matched:string}}
 */
function checkText(text) {
  if (!config.chatFilter.enabled) return { ok: true };
  const norm = normalize(text);
  if (!norm) return { ok: true };
  // spaces removed entirely — catches "b nchod", "khanki pola" → "khankipola"
  const squeezed = norm.replace(/ /g, '');
  for (const p of PREPARED) {
    if (!p.term) continue;
    if (p.short) {
      // short ASCII terms need word boundaries (avoid the Scunthorpe problem)
      if (norm.split(' ').some((w) => w === p.term)) {
        return { ok: false, reason: 'profanity', matched: p.term };
      }
    } else if (norm.includes(p.term) || squeezed.includes(p.term)) {
      return { ok: false, reason: 'profanity', matched: p.term };
    }
  }
  return { ok: true };
}

// ---- strikes → temporary chat timeout ---------------------------------------
const STRIKE_WINDOW_MS = 10 * 60 * 1000;   // strikes expire after 10 minutes
const STRIKES_TO_TIMEOUT = 3;
const TIMEOUT_MS = 10 * 60 * 1000;         // 10 minutes off chat

/** userId → { strikes: [ts…], until: ts } */
const users = new Map();

function recordStrike(userId) {
  const now = Date.now();
  const u = users.get(userId) || { strikes: [], until: 0 };
  u.strikes = u.strikes.filter((t) => now - t < STRIKE_WINDOW_MS);
  u.strikes.push(now);
  if (u.strikes.length >= STRIKES_TO_TIMEOUT) {
    u.until = now + TIMEOUT_MS;
    u.strikes = [];
  }
  users.set(userId, u);
  return u;
}

/** True when the user is serving a spam/abuse timeout. */
function isTimedOut(userId) {
  const u = users.get(userId);
  return !!u && u.until > Date.now();
}

/** Seconds left on an active timeout (0 when none). */
function timeoutLeftSec(userId) {
  const u = users.get(userId);
  return u && u.until > Date.now() ? Math.ceil((u.until - Date.now()) / 1000) : 0;
}

// periodic cleanup so the map never grows without bound
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of users) {
    if (u.until < now && u.strikes.every((t) => now - t >= STRIKE_WINDOW_MS)) users.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { checkText, recordStrike, isTimedOut, timeoutLeftSec, normalize };
