import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = ['tsx','--import','./tests/helpers/css-stub-loader.mjs','--test','--test-force-exit','--test-timeout=120000','--test-concurrency=6','--test-reporter=tap','--test-reporter-destination=stdout','tests/*.test.ts','tests/contract/*.test.ts'];
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: ['ignore','pipe','pipe'], shell: process.platform === 'win32', env: { ...process.env, NODE_ENV:'test', BOBBIT_TEST_NO_EXTERNAL:'1', BOBBIT_TEST_NO_REMOTE:'1' }});
let out=''; let err='';
child.stdout.on('data', c => { out += c; if (out.length > 200000) out = out.slice(-200000); });
child.stderr.on('data', c => { err += c; if (err.length > 200000) err = err.slice(-200000); });
child.on('close', (code, sig) => { writeFileSync('.profiles/node-debug.out', `code=${code} sig=${sig}\n---STDOUT---\n${out}\n---STDERR---\n${err}`); process.exit(code ?? 1); });
