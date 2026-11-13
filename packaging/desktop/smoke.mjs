// CI smoke test for the unpacked desktop build.
//   node smoke.mjs <path to app executable> [extra args...]
// Starts the app, waits up to 30 s for version.json, index.html and worker.js to answer 200 on
// http://127.0.0.1:47831, checks the app is still running 10 s later, then stops it. Exit code 1 on failure.
import { spawn, execFileSync } from 'node:child_process';

const [exe, ...args] = process.argv.slice(2);
if (!exe) { console.error('usage: node smoke.mjs <executable> [args...]'); process.exit(2); }

const BASE = 'http://127.0.0.1:47831';
const PATHS = ['/data/version.json', '/index.html', '/worker.js'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });
child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[app] ${d}`));

function stop() {
  if (exited) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

async function status(p) {
  try {
    const res = await fetch(BASE + p, { signal: AbortSignal.timeout(3000) });
    await res.arrayBuffer();
    return res.status;
  } catch { return 0; }
}

let ok = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline && !exited) {
  const codes = await Promise.all(PATHS.map(status));
  if (codes.every((c) => c === 200)) {
    console.log(`smoke: all answered 200 after ${30 - Math.round((deadline - Date.now()) / 1000)} s: ${PATHS.join(', ')}`);
    ok = true;
    break;
  }
  await sleep(1000);
}

if (!ok) {
  console.log(`smoke: FAIL, URLs did not all answer 200 within 30 s${exited ? ` (app exited ${JSON.stringify(exited)})` : ''}`);
  stop();
  process.exit(1);
}

await sleep(10000);
if (exited) {
  console.log(`smoke: FAIL, app exited within 10 s after start: ${JSON.stringify(exited)}`);
  process.exit(1);
}
console.log('smoke: app still running after 10 more seconds; PASS');
stop();
await sleep(1000);
process.exit(0);
