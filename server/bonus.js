'use strict';

/**
 * Panda Voice — daily bonus streak.
 *
 * Pure logic, separated so it can be unit-tested: day index is
 * floor(time / DAY_MS), a claim on consecutive days escalates the streak
 * (capped at 7), a missed day resets it to 1, and the award grows with the
 * streak.
 */

const DAY_MS = 86_400_000;

/**
 * Decide a claim attempt.
 * @param {number|null} lastBonusDay day index of the previous claim
 * @param {number} today current day index
 * @param {number} prevStreak streak counted so far
 * @returns {{claimed:true}|{claimed:false, streak:number}}
 */
function streakFor(lastBonusDay, today, prevStreak) {
  if (lastBonusDay !== null && lastBonusDay !== undefined && lastBonusDay === today) {
    return { claimed: true };
  }
  const consecutive = lastBonusDay === today - 1;
  const streak = consecutive ? (prevStreak || 0) + 1 : 1;
  return { claimed: false, streak: Math.min(streak, 7) };
}

/** Escalating award: base on day 1, +step per streak day (day 7+ = base + 6×step). */
function awardFor(base, streak, step = 25) {
  return base + (Math.max(1, Math.min(streak, 7)) - 1) * step;
}

module.exports = { DAY_MS, streakFor, awardFor };
