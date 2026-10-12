import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIBudget } from '../budget.js';
import { MODEL, PRICE_VALID_UNTIL, PRICES, costMicros } from '../pricing.js';
function files() {
  const values = new Map();
  return { existsSync: n => values.has(n), readFileSync: n => values.get(n), writeFileSync: (n, v) => values.set(n, v) };
}
const request = { model: MODEL, maxOutput: 8192 };
test('total dollars reserve before requests, never roll over, survive restart and block before overspend', () => {
  const fs = files(); let day = Date.UTC(2026, 9, 12);
  const make = () => createAIBudget(fs, { COACH_AI_BUDGET_USD: '0.16' }, () => day);
  const one = make(); one(request); day += 86400000; const two = make(); two(request);
  assert.throws(() => two(request), /exhausted/);
  const s = two.status(); assert.equal(s.attempts, 2); assert.ok(s.reservedMicros <= s.totalMicros);
  assert.equal(s.spentMicros, 0); assert.equal(s.automaticTopUp, false); assert.equal(s.topUpNeeded, true);
});
test('settles valid usage once; uncertain, out-of-bounds and corrupt usage never release reservation', () => {
  const fs = files(), budget = createAIBudget(fs, { COACH_AI_BUDGET_USD: '5' }, () => Date.UTC(2026, 9, 12));
  const a = budget(request), b = budget(request), max = costMicros(MODEL, 80000, 8192);
  for (const usage of [undefined, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: 9000 }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 }]) budget.settle(a, usage);
  assert.equal(budget.status().reservedMicros, max * 2);
  const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
  budget.settle(a, usage); const after = budget.status(); budget.settle(a, usage); budget.settle('unknown', usage);
  assert.deepEqual(budget.status(), after);
  assert.equal(after.spentMicros, costMicros(MODEL, 1000, 100)); assert.equal(after.reservedMicros, max);
  assert.equal(typeof b, 'string');
});
test('unconfigured, expired, unknown-model, legacy and corrupted budgets fail closed', () => {
  for (const env of [{}, { COACH_AI_BUDGET_USD: '-1' }, { COACH_AI_BUDGET_USD: 'NaN' }]) assert.throws(() => createAIBudget(files(), env)(request));
  const fs = files(), env = { COACH_AI_BUDGET_USD: '5' };
  assert.throws(() => createAIBudget(fs, env, () => PRICE_VALID_UNTIL)(request));
  assert.throws(() => createAIBudget(fs, env)({ ...request, model: 'unknown' }));
  fs.writeFileSync('/data/coach-ai-budget.json', '{}'); assert.throws(() => createAIBudget(fs, env)(request), /Legacy/);
  fs.writeFileSync('/data/coach-ai-ledger.json', '{invalid'); assert.throws(() => createAIBudget(fs, env)(request));
});
test('rates conservatively cover both displayed token rates and neuron-based billing', () => {
  assert.ok(PRICES[MODEL].outputNano >= 443756 * 11 / 1000);
  assert.ok(PRICES['@cf/meta/llama-3.3-70b-instruct-fp8-fast'].inputNano >= 26668 * 11 / 1000);
  assert.equal(costMicros(MODEL, 80000, 8192), 79754);
});
