import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createStorage } from '../storage.js';
import { createCoach } from '../coach.js';
import { workersAI, MODEL } from '../ai.js';
import { RETIRED_MODEL, costMicros } from '../pricing.js';
import { reviewState as sampleState } from '../../api/test/helpers.mjs';

function setup(t, mode = '') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: { exec(q, ...args) { const rows = db.prepare(q).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('SAVEPOINT tx'); try { const r = fn(); db.exec('RELEASE tx'); return r; }
      catch(e) { db.exec('ROLLBACK TO tx; RELEASE tx'); throw e; } }
  };
  const fs = createStorage(storage);
  fs.writeFileSync('/data/secret', 'synthetic-secret');
  const calls = [];
  const ai = { async run(model, input) {
    calls.push({ model, input });
    return { response: execFileSync(process.execPath, [new URL('../../api/coach/fixture-cli.mjs', import.meta.url).pathname], {
      input: input.messages.map(m => m.content).join('\n\n'), encoding: 'utf8', env: { ...process.env, FIXTURE_MODE: mode }
    }) };
  } };
  const make = () => createCoach({ fs, env: { DATA_DIR: '/data', AI: ai, COACH_AI_BUDGET_USD: '5' }, defer() {} });
  let coach = make();
  coach.cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: 4096, models: { 'workers-ai': RETIRED_MODEL } });
  const write = (id, state = sampleState()) => fs.writeFileSync('/data/state-' + id + '.json', JSON.stringify(state));
  return { fs, calls, ai, make, coach, write };
}

test('durable Coach: queued jobs survive restart, single-flight/caps persist, retry does not repeat completed inference', async t => {
  const h = setup(t); h.write('a');
  h.coach.jobs.enqueue('a', { kind: 'review' });
  assert.equal(h.calls.length, 0);
  assert.throws(() => h.coach.jobs.enqueue('a', { kind: 'review' }), e => e.code === 'busy');
  const next = h.make(); next.jobs.recoverOnBoot();
  await next.jobs.runQueued();
  assert.equal(h.calls.length, 1);
  assert.equal(next.jobs.status('a').last.outcome, 'ready');
  assert.ok(next.jobs.status('a').pending.planHash);
  await next.jobs.runQueued();
  assert.equal(h.calls.length, 1);
  next.cfgStore.save({ caps: { perProfileDaily: 1, instanceDaily: 1 } });
  assert.throws(() => next.jobs.enqueue('a', { kind: 'review' }), e => e.code === 'cap');
  const restored = h.make(); restored.jobs.recoverOnBoot();
  assert.equal(restored.jobs.status('a').pending.id, next.jobs.status('a').pending.id);
});

test('Workers AI uses native schema shape; malformed answer repairs once; unknown exercises never become proposals', async t => {
  for (const mode of ['invalid-then-valid', 'unknown-exercise']) {
    const h = setup(t, mode); h.write('a');
    h.coach.jobs.enqueue('a', { kind: 'review' });
    await h.coach.jobs.runQueued();
    assert.equal(h.calls.length, 2);
    assert.equal(h.coach.cfgStore.load().models['workers-ai'], RETIRED_MODEL);
    assert.equal(h.calls[0].model, MODEL);
    assert.equal(h.calls[0].input.stream, false);
    assert.equal(h.calls[0].input.temperature, 0);
    assert.deepEqual(h.calls[0].input.response_format, { type: 'json_object' });
    assert.equal(h.coach.jobs.status('a').last.outcome, mode === 'invalid-then-valid' ? 'ready' : 'failed');
    if (mode === 'unknown-exercise') assert.equal(h.coach.jobs.status('a').pending, null);
  }
});

test('create, refine and debrief use the existing validation pipeline', async t => {
  const h = setup(t); h.write('a');
  h.coach.jobs.enqueue('a', { kind: 'create' }); await h.coach.jobs.runQueued();
  assert.equal(h.coach.jobs.status('a').last.outcome, 'ready', JSON.stringify(h.coach.cfgStore.load().log));
  assert.equal(h.calls[0].input.response_format.json_schema.name, 'coach_answer');
  assert.equal(h.calls[0].input.response_format.json_schema.schema.type, 'object');
  h.coach.jobs.enqueue('a', { kind: 'create', refine: 'Use the same equipment' }); await h.coach.jobs.runQueued();
  assert.equal(h.coach.jobs.status('a').pending.iteration, 2);
  h.coach.jobs.resolvePending('a', { accepted: ['r1'] });
  assert.equal(h.coach.jobs.status('a').pending, null);
  h.coach.jobs.enqueue('a', { kind: 'debrief', workoutId: 'w1' }); await h.coach.jobs.runQueued();
  assert.equal(h.coach.jobs.status('a').last.outcome, 'ready', JSON.stringify(h.coach.cfgStore.load().log));
  assert.equal(h.calls[0].input.response_format.json_schema.name, 'coach_answer');
  assert.equal(h.calls[0].input.response_format.json_schema.schema.type, 'object');
});

test('consent revoked while queued prevents inference; running interruption is recorded without replay', async t => {
  const h = setup(t); h.write('a'); h.coach.jobs.enqueue('a', { kind: 'review' });
  h.write('a', sampleState({ coach: {} })); await h.coach.jobs.runQueued();
  assert.equal(h.calls.length, 0);
  assert.equal(h.coach.jobs.status('a').last.errorClass, 'consent');
  h.write('b'); h.coach.jobs.enqueue('b', { kind: 'review' });
  const rec = h.coach.jobs.readUser('b'); rec.current.state = 'running';
  h.fs.writeFileSync('/data/coach/b.json', JSON.stringify(rec));
  const next = h.make(); next.jobs.recoverOnBoot(); await next.jobs.runQueued();
  assert.equal(next.jobs.status('b').last.errorClass, 'restart');
  assert.equal(h.calls.length, 0);
});

test('forget during inference cancels publication, and preserves daily budget', async t => {
  const h = setup(t); h.write('a');
  let entered, release;
  const started = new Promise(r => { entered = r; });
  h.ai.run = async () => { entered(); return new Promise(r => { release = r; }); };
  h.coach.jobs.enqueue('a', { kind: 'review' });
  const running = h.coach.jobs.runQueued(); await started;
  h.coach.jobs.clearUser('a'); release({ response: '{"coach_contract":1,"nochange":true}' });
  await running;
  assert.equal(h.coach.jobs.status('a').pending, null);
  assert.equal(h.coach.jobs.readUser('a').history.length, 0);
  assert.equal(h.coach.jobs.capState('a').used, 1);
});

test('context budget and pre-cancelled calls never invoke a model; errors do not echo payloads', async () => {
  let calls = 0;
  const adapter = workersAI({ async run() { calls++; throw new Error('private prompt content'); } });
  const oversized = await adapter.invoke({ prompt: 'x'.repeat(300000) });
  assert.equal(oversized.code, 1); assert.equal(calls, 0);
  const ctl = new AbortController(); ctl.abort();
  await adapter.invoke({ prompt: 'synthetic', signal: ctl.signal }); assert.equal(calls, 0);
  const r = await adapter.invoke({ prompt: 'synthetic' });
  assert.equal(r.code, 1); assert.ok(!r.stderr.includes('private prompt'));
});


test('a retired Workers AI id calls Gemma, chat content validates, and Llama keeps its schema', async t => {
  const h = setup(t);
  h.ai.run = async (model, input) => {
    h.calls.push({ model, input });
    const text = execFileSync(process.execPath, [new URL('../../api/coach/fixture-cli.mjs', import.meta.url).pathname], {
      input: input.messages.map(m => m.content).join('\n\n'), encoding: 'utf8', env: { ...process.env, FIXTURE_MODE: '' }
    });
    return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
  };
  h.write('a');
  h.coach.jobs.enqueue('a', { kind: 'review' });
  await h.coach.jobs.runQueued();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].model, MODEL);
  assert.equal(h.coach.cfgStore.load().models['workers-ai'], RETIRED_MODEL);
  assert.equal(h.coach.jobs.status('a').last.outcome, 'ready');
  assert.equal(h.coach.budget.status().spentMicros, costMicros(MODEL, 12, 8));
  assert.equal(h.coach.budget.status().reservedMicros, 0);
  h.coach.jobs.resolvePending('a', { accepted: [] });
  const listed = await workersAI(h.ai).check();
  assert.ok(listed.models.includes(MODEL));
  assert.equal(listed.models.includes(RETIRED_MODEL), false);
  const coach = createCoach({ fs: h.fs, env: { DATA_DIR: '/data', AI: h.ai, COACH_AI_BUDGET_USD: '5', COACH_AI_MODEL: RETIRED_MODEL }, defer() {} });
  coach.cfgStore.save({ models: {} });
  assert.equal(coach.cfgStore.modelFor(), MODEL);
  coach.jobs.enqueue('a', { kind: 'review' });
  await coach.jobs.runQueued();
  assert.equal(h.calls.at(-1).model, MODEL);
  assert.equal(coach.cfgStore.load().models['workers-ai'], undefined);
  const seen = [];
  const llama = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const adapter = workersAI({ async run(model, input) { seen.push({ model, input }); return { response: '{"coach_contract":1}' }; } });
  const schema = { type: 'object', properties: { days: { type: 'array' } } };
  const legacy = await adapter.invoke({ prompt: 'synthetic', model: llama, schema });
  assert.equal(legacy.code, 0);
  assert.equal(legacy.text, '{"coach_contract":1}');
  assert.equal(seen[0].model, llama);
  assert.equal(seen[0].input.response_format.json_schema.type, 'object');
  assert.equal(seen[0].input.response_format.json_schema.schema, undefined);
  const accepted = await adapter.invoke({ prompt: 'x'.repeat(100000), model: MODEL, schema });
  assert.equal(accepted.code, 0);
  assert.equal(seen.at(-1).model, MODEL);
  assert.equal(seen.at(-1).input.response_format.json_schema.schema.type, 'object');
  assert.equal(seen.at(-1).input.max_tokens >= 1024, true);
  const blocked = await adapter.invoke({ prompt: 'x'.repeat(300000), model: MODEL, schema });
  assert.equal(blocked.code, 1);
  assert.equal(seen.length, 2);
  const review = await adapter.invoke({ prompt: 'synthetic', model: RETIRED_MODEL, schema: { type: 'object', properties: { changes: { type: 'array' } } } });
  assert.equal(review.code, 0);
  assert.equal(seen.at(-1).model, MODEL);
  assert.deepEqual(seen.at(-1).input.response_format, { type: 'json_object' });
});

test('an explicit Scout selection is called as Scout and is not replaced by Gemma', async t => {
  const scout = '@cf/meta/llama-4-scout-17b-16e-instruct';
  const h = setup(t);
  const coach = createCoach({ fs: h.fs, env: { DATA_DIR: '/data', AI: h.ai, COACH_AI_BUDGET_USD: '5', COACH_AI_MODEL: scout }, defer() {} });
  coach.cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: 4096, models: {} });
  assert.equal(coach.cfgStore.modelFor(), scout);
  h.write('scout');
  coach.jobs.enqueue('scout', { kind: 'review' });
  await coach.jobs.runQueued();
  assert.equal(h.calls.at(-1).model, scout);
  assert.equal(coach.cfgStore.load().models['workers-ai'], undefined);
  coach.cfgStore.save({ models: { 'workers-ai': scout } });
  h.write('scout-saved');
  coach.jobs.enqueue('scout-saved', { kind: 'review' });
  await coach.jobs.runQueued();
  assert.equal(h.calls.at(-1).model, scout);
  assert.equal(coach.cfgStore.load().models['workers-ai'], scout);
  const seen = [];
  const adapter = workersAI({ async run(model, input) { seen.push({ model, input }); return { response: '{"coach_contract":1}' }; } });
  const schema = { type: 'object', properties: { days: { type: 'array' } } };
  const called = await adapter.invoke({ prompt: 'synthetic', model: scout, schema });
  assert.equal(called.code, 0);
  assert.equal(seen[0].model, scout);
  assert.equal(seen[0].input.response_format.json_schema.type, 'object');
  assert.equal(seen[0].input.response_format.json_schema.name, undefined);
});

test('inference allowance persists across restart and forget, and is disabled by default', async t => {
  const h = setup(t); h.write('a');
  h.fs.writeFileSync('/data/coach-ai-budget.json', JSON.stringify({ day: new Date().toISOString().slice(0, 10), used: 10 }));
  const next = h.make(); next.jobs.enqueue('a', { kind: 'review' }); await next.jobs.runQueued();
  assert.equal(h.calls.length, 0);
  next.jobs.clearUser('a');
  assert.equal(JSON.parse(h.fs.readFileSync('/data/coach-ai-budget.json', 'utf8')).used, 10);
  h.fs.unlinkSync('/data/coach-ai-budget.json');
  const disabled = createCoach({ fs: h.fs, env: { DATA_DIR: '/data', AI: h.ai }, defer() {} });
  disabled.jobs.enqueue('a', { kind: 'review' }); await disabled.jobs.runQueued();
  assert.equal(h.calls.length, 0);
});
