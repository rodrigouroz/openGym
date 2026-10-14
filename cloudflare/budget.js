import crypto from 'node:crypto';
import { PRICES, PRICE_VALID_UNTIL, PRICE_CHECKED, costMicros } from './pricing.js';

// One synchronous ledger in the installation DO. Money is integer microdollars.
// Every attempt reserves its full context + maximum output before the binding is
// invoked. Only validated provider usage releases the unused reservation. Missing,
// failed, cancelled or ambiguous responses retain the entire reservation forever.
export function createAIBudget(fs, env, now = Date.now, flush = async () => {}) {
  const file = '/data/coach-ai-ledger.json';
  const limit = () => {
    const raw = String(env.COACH_AI_BUDGET_USD || '0');
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('Invalid AI budget');
    const value = Math.round(Number(raw) * 1e6);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('AI budget not configured');
    return value;
  };
  const read = () => {
    if (!fs.existsSync(file)) {
      // A previous call-count ledger is not evidence of actual historical dollars.
      if (fs.existsSync('/data/coach-ai-budget.json')) throw new Error('Legacy AI usage needs reconciliation');
      return { version: 1, spentMicros: 0, reservedMicros: 0, attempts: 0, entries: {} };
    }
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (b.version !== 1 || ![b.spentMicros, b.reservedMicros, b.attempts].every(n => Number.isSafeInteger(n) && n >= 0)
      || !b.entries || typeof b.entries !== 'object' || Array.isArray(b.entries)) throw new Error('Invalid AI ledger');
    let outstanding = 0;
    for (const e of Object.values(b.entries)) {
      if (!e || !PRICES[e.model] || ![e.maxInput, e.maxOutput, e.reserved].every(n => Number.isSafeInteger(n) && n >= 0)
        || e.maxInput !== PRICES[e.model].context || e.maxOutput > 8192
        || e.reserved !== costMicros(e.model, e.maxInput, e.maxOutput)) throw new Error('Invalid AI receipt');
      if (!e.settled) outstanding += e.reserved;
    }
    if (outstanding !== b.reservedMicros) throw new Error('Inconsistent AI ledger');
    return b;
  };
  const save = b => fs.writeFileSync(file, JSON.stringify(b));
  const status = () => {
    try {
      const b = read(), totalMicros = limit();
      const remainingMicros = Math.max(0, totalMicros - b.spentMicros - b.reservedMicros);
      const nextMaxMicros = Math.max(...Object.keys(PRICES).map(m => costMicros(m, PRICES[m].context, 8192)));
      return { totalMicros, spentMicros: b.spentMicros, reservedMicros: b.reservedMicros, remainingMicros,
        attempts: b.attempts, nextMaxMicros, low: remainingMicros < 250000,
        topUpNeeded: remainingMicros < nextMaxMicros, priceChecked: PRICE_CHECKED,
        pricingExpired: now() >= PRICE_VALID_UNTIL, automaticTopUp: false };
    } catch { return { blocked: true, error: 'AI budget needs configuration or ledger reconciliation', automaticTopUp: false }; }
  };
  const reserve = ({ model, maxOutput }) => {
    const p = PRICES[model];
    if (!p || now() >= PRICE_VALID_UNTIL || !Number.isSafeInteger(maxOutput) || maxOutput < (p.outputNano === 0 ? 0 : 1) || maxOutput > 8192) throw new Error('AI pricing unavailable');
    const maxCost = costMicros(model, p.context, maxOutput), b = read();
    if (b.spentMicros + b.reservedMicros + maxCost > limit()) throw new Error('AI budget exhausted: top-up approval needed');
    const id = crypto.randomUUID();
    b.entries[id] = { model, maxInput: p.context, maxOutput, reserved: maxCost, at: now() };
    b.reservedMicros += maxCost; b.attempts++;
    save(b);
    return id;
  };
  reserve.flush = flush;
  reserve.status = status;
  reserve.settle = (id, usage) => {
    const b = read(), e = b.entries[id];
    if (!e || e.settled) return;
    const input = usage?.prompt_tokens, output = usage?.completion_tokens;
    if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)
      || input > e.maxInput || output > e.maxOutput
      || (usage.total_tokens != null && usage.total_tokens !== input + output)) return;
    const cost = costMicros(e.model, input, output);
    if (cost > e.reserved) return;
    b.reservedMicros -= e.reserved; b.spentMicros += cost;
    b.entries[id] = { ...e, settled: true, input, output, cost };
    // Keep unresolved attempts and the last 100 settled receipts. Deleting a
    // settled receipt cannot permit settlement twice: an unknown id is a no-op.
    const old = Object.entries(b.entries).filter(([, v]) => v.settled).slice(0, -100);
    for (const [key] of old) delete b.entries[key];
    save(b);
  };
  return reserve;
}
