import test from 'node:test';
import assert from 'node:assert/strict';
import { observeDecision } from '../decision.js';
import { createAIBudget } from '../budget.js';
import { DECISION_MODEL, costMicros } from '../pricing.js';
function ledger(total = '5') {
  const files = new Map();
  return createAIBudget({ existsSync: n => files.has(n), readFileSync: n => files.get(n), writeFileSync: (n, v) => files.set(n, v) }, { COACH_AI_BUDGET_USD: total }, () => Date.UTC(2026, 9, 12));
}
const answer = { type: 'choice', choice: 'insufficient_data', probabilities: { continue: 0.01, full_review: 0.01, insufficient_data: 0.98 }, confidence: 0.96 };
test('decision observations reserve the shared dollars before calling and never provide a plan', async () => {
  const budget = ledger(); let calls = 0;
  const observe = observeDecision({ async run(model) {
    calls++; assert.equal(model, DECISION_MODEL); assert.equal(budget.status().attempts, 1);
    assert.equal(budget.status().reservedMicros, costMicros(DECISION_MODEL, 24576, 0));
    return { answers: { triage: answer }, usage: { input_tokens: 100, output_tokens: 0 } };
  } }, budget);
  const r = await observe({ sessions: 1 });
  assert.equal(r.status, 'observed'); assert.equal(r.choice, 'insufficient_data'); assert.equal(r.plan, undefined);
  assert.equal(calls, 1); assert.equal(budget.status().reservedMicros, 0); assert.equal(budget.status().spentMicros, 4);
});
test('invalid and uncertain decisions never become recommendations; no budget prevents any call', async () => {
  for (const bad of [{ ...answer, choice: 'increase_weights' }, { ...answer, probabilities: { continue: 1 } }, { ...answer, confidence: NaN }]) {
    const r = await observeDecision({ run: async () => ({ answers: { triage: bad } }) }, ledger())({}); assert.equal(r.status, 'rejected');
  }
  const low = { ...answer, confidence: 0.2 };
  assert.equal((await observeDecision({ run: async () => ({ answers: { triage: low } }) }, ledger())({})).status, 'uncertain');
  let called = false;
  assert.equal((await observeDecision({ run() { called = true; } }, ledger('0.000001'))({})).status, 'unavailable');
  assert.equal(called, false);
});
