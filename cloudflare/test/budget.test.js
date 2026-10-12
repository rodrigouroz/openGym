import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIBudget } from '../budget.js';

function files() {
  const values = new Map();
  return { existsSync: n => values.has(n), readFileSync: n => values.get(n), writeFileSync: (n, v) => values.set(n, v) };
}
test('one-time allowance survives restart and midnight, counts every attempt, and never refunds', () => {
  const fs = files(); let day = Date.UTC(2026, 9, 12);
  const make = () => createAIBudget(fs, { COACH_AI_TOTAL_CALLS: '8' }, () => day);
  let reserve = make();
  for (let i = 0; i < 8; i++) { reserve(); day += 86400000; reserve = make(); }
  assert.throws(reserve, /exhausted/);
  assert.equal(JSON.parse(fs.readFileSync('/data/coach-ai-budget.json')).totalUsed, 8);
});
test('daily and total caps both apply, with absent, invalid and legacy totals failing closed', () => {
  const fs = files(); let day = Date.UTC(2026, 9, 12);
  const reserve = createAIBudget(fs, { COACH_AI_TOTAL_CALLS: '2', COACH_AI_DAILY_CALLS: '1' }, () => day);
  reserve(); assert.throws(reserve); day += 86400000; reserve(); day += 86400000; assert.throws(reserve);
  for (const env of [{}, { COACH_AI_TOTAL_CALLS: '-1' }, { COACH_AI_TOTAL_CALLS: 'NaN' }]) assert.throws(createAIBudget(files(), env));
  const legacy = files(); legacy.writeFileSync('/data/coach-ai-budget.json', JSON.stringify({ day: '2026-10-12', used: 1 }));
  assert.throws(createAIBudget(legacy, { COACH_AI_TOTAL_CALLS: '8' }), /exhausted/);
});
