// One-shot: start the forge, wait for it, run the conformance tests, stop it.
// Run:  node run-tests.mjs
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const forge = spawn(process.execPath, ['main.ts'], {
  env: { ...process.env, MAKEFUN_ENV_URL: 'http://127.0.0.1:59999', PORT: '8931' },
  stdio: 'inherit',
});
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try {
    const r = await fetch('http://127.0.0.1:8931/health');
    up = r.status === 200;
  } catch {}
}
if (!up) { console.error('forge did not start'); forge.kill(); process.exit(1); }
console.log('=== forge up, running conformance tests ===');
let code = 0;
try {
  execFileSync(process.execPath, ['test-forge.mjs'], { stdio: 'inherit' });
} catch (e) {
  code = 1;
}
forge.kill('SIGKILL');
process.exit(code);
