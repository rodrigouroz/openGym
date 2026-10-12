// Synthetic-only, one-time validation. Default invocation is a network-free plan.
// Live execution requires separately obtained spending approval and existing credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createStorage } from '../storage.js';
import { createCoach } from '../coach.js';
import { MODEL } from '../ai.js';
import { sampleState } from '../../api/test/helpers.mjs';

const mode = process.argv[2] || '--plan';
if (!['--plan', '--fixture', '--execute'].includes(mode) || process.argv.length > 3) throw new Error('Use --plan, --fixture or --execute');
const CALLS = 8, MAX_INPUT = 80000, MAX_OUTPUT = 8192;
const ceiling = CALLS * (MAX_INPUT * 0.497 + MAX_OUTPUT * 4.881) / 1e6;
console.log(JSON.stringify({ model: MODEL, totalAttempts: CALLS, maxInputTokens: MAX_INPUT, maxOutputTokens: MAX_OUTPUT,
  modelCostCeilingUSD: ceiling, pricingChecked: '2026-10-12', recurringAllowance: false,
  note: 'Recheck current model prices before executing. No production profile data is read. Workers/storage charges are separate.' }));
if (mode === '--plan') process.exit(0);
if (mode === '--execute' && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) throw new Error('Provide existing authorized Cloudflare credentials via environment; do not create a new token for this test');
const root = fileURLToPath(new URL('../.wrangler/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const name = mode === '--execute' ? 'synthetic-ai-once' : 'synthetic-ai-fixture';
const lock = path.join(root, name + '.lock');
// Concurrent processes must never race the read/reserve/write. A crash leaves the
// lock in place; inspect it and the durable budget before deliberately resuming.
const lockFd = fs.openSync(lock, 'wx', 0o600);
let db;
try {
  db = new DatabaseSync(path.join(root, name + '.sqlite'));
  db.exec('PRAGMA synchronous=FULL');
  const storage = {
    sql: { exec(q, ...args) { const rows = db.prepare(q).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('SAVEPOINT tx'); try { const r = fn(); db.exec('RELEASE tx'); return r; }
      catch(e) { db.exec('ROLLBACK TO tx; RELEASE tx'); throw e; } }
  };
  const files = createStorage(storage);
  if (!files.existsSync('/data/secret')) files.writeFileSync('/data/secret', 'synthetic-smoke-secret-not-a-production-credential');
  const ai = { async run(model, input) {
    if (model !== MODEL || input.max_tokens > MAX_OUTPUT) throw new Error('Unexpected model or output budget');
    if (mode === '--fixture') return { response: execFileSync(process.execPath,
      [fileURLToPath(new URL('../../api/coach/fixture-cli.mjs', import.meta.url))],
      { input: input.messages.map(m => m.content).join('\n\n'), encoding: 'utf8' }) };
    // No network retry. An ambiguous timeout still consumes its reserved attempt.
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${MODEL}`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(300000)
    });
    if (!response.ok) throw new Error('Inference request failed');
    const result = await response.json();
    if (!result.success || !result.result) throw new Error('Inference response failed');
    return result.result;
  } };
  const coach = createCoach({ fs: files, env: { DATA_DIR: '/data', AI: ai, COACH_AI_TOTAL_CALLS: String(CALLS) }, defer() {} });
  coach.cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: MAX_OUTPUT, models: { 'workers-ai': MODEL } });
  coach.jobs.recoverOnBoot();
  const uid = 'synthetic-validation';
  if (!files.existsSync('/data/state-' + uid + '.json')) files.writeFileSync('/data/state-' + uid + '.json', JSON.stringify(sampleState()));
  const scenarios = [{ id: 'create', kind: 'create' }, { id: 'refine', kind: 'create', refine: 'Keep the same equipment and use a shorter session.' },
    { id: 'review', kind: 'review' }, { id: 'debrief', kind: 'debrief', workoutId: 'w1' }];
  for (const scenario of scenarios) {
    const marker = '/data/smoke-' + scenario.id;
    if (files.existsSync(marker)) continue;
    const { id, ...job } = scenario;
    coach.jobs.enqueue(uid, job);
    await coach.jobs.runQueued();
    const last = coach.jobs.status(uid).last;
    const summary = { scenario: id, outcome: last?.outcome, errorClass: last?.errorClass ?? null };
    files.writeFileSync(marker, JSON.stringify(summary));
    console.log(JSON.stringify(summary));
    if (id !== 'create') coach.jobs.resolvePending(uid, { accepted: [] });
  }
  console.log(JSON.stringify({ budget: JSON.parse(files.readFileSync('/data/coach-ai-budget.json', 'utf8')) }));
} finally {
  db?.close(); fs.closeSync(lockFd); fs.unlinkSync(lock);
}
