/* Shared helpers for the integration tests. */

export const BASE = process.env.BASE_URL || 'http://localhost:8080';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with 429 handling.
 *
 * The server rate limits auth and room creation per IP. Running this suite
 * several times from one machine legitimately trips those limits, so rather
 * than failing we honour the advertised retry delay. Raise the server's limits
 * (AUTH_ATTEMPTS_PER_MIN / ROOMS_PER_HOUR) to make repeated runs instant.
 */
export async function apiFetch(path, { method = 'GET', token, body, maxWaitMs = 120_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status !== 429) {
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }
      return { status: res.status, ok: res.ok, data };
    }

    // rate limited — wait it out, but never forever
    const retryAfter = Number(res.headers.get('retry-after')) || 5;
    const waitMs = Math.min(retryAfter * 1000 + 250, 15_000);
    if (Date.now() - started + waitMs > maxWaitMs) {
      throw new Error(`rate limited at ${path} and the retry budget (${maxWaitMs}ms) is spent — ` +
        'restart the server or raise its limits to run the suite again');
    }
    await sleep(waitMs);
  }
}

let seq = 0;

/**
 * A throwaway account for this run.
 *
 * Tests must not depend on state left behind by earlier runs: the per-user
 * room-creation limit would otherwise trip after a few executions.
 */
export async function freshUser(name) {
  const username = `t${Date.now().toString(36)}${(seq++).toString(36)}`.slice(0, 20);
  const { status, data } = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'test1234', displayName: name || `Tester ${seq}` },
  });
  if (!data?.token) throw new Error(`could not create a test account (HTTP ${status}): ${data?.error}`);
  return data;
}

/** Create a room with retry-aware fetching. */
export async function createRoom(token, fields) {
  const { status, data } = await apiFetch('/api/rooms', { method: 'POST', token, body: fields });
  if (!data?.room) throw new Error(`could not create a room (HTTP ${status}): ${data?.error}`);
  return data;
}

/** Socket.IO emit wrapped in a promise, with a timeout. */
export function emitAck(sock, evt, payload = {}, timeoutMs = 5000) {
  return new Promise((resolve) => {
    sock.emit(evt, payload, resolve);
    setTimeout(() => resolve({ ok: false, error: `ack timeout for ${evt}` }), timeoutMs);
  });
}

/** Tiny assertion reporter. */
export function makeReporter(title) {
  let pass = 0, fail = 0;
  console.log(`\n════ ${title} ════\n`);
  return {
    check(name, ok, extra = '') {
      console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
      ok ? pass++ : fail++;
      return ok;
    },
    section(name) { console.log(`\n  — ${name} —`); },
    finish() {
      console.log(`\n════ RESULT: ${pass} passed, ${fail} failed ════\n`);
      return fail === 0;
    },
  };
}
