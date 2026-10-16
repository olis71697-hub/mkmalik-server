/* Runs every integration test against a live server. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8080';

async function reachable(url, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + '/api/health');
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      stdio: 'inherit',
      env: { ...process.env, BASE_URL: BASE },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

console.log(`\nChecking ${BASE} …`);
if (!await reachable(BASE)) {
  console.error(`\n❌ No server at ${BASE}. Start it first with:  npm start\n`);
  process.exit(1);
}

let failed = 0;
for (const file of ['voice-e2e.mjs', 'peer-topology.mjs']) {
  console.log(`\n──────── ${file} ────────`);
  failed += await run(file) === 0 ? 0 : 1;
}

if (failed) { console.error(`\n❌ ${failed} test file(s) failed\n`); process.exit(1); }
console.log('\n✅ all integration tests passed\n');
process.exit(0);
