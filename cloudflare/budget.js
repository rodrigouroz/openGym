// Reserve synchronously before every attempt, including repairs and admin tests.
// Never refund failed/cancelled/ambiguous calls. A total allowance never rolls over.
export function createAIBudget(fs, env, now = Date.now) {
  const limit = key => {
    const n = Number(env[key] || 0);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid AI allowance');
    return n;
  };
  return () => {
    const daily = limit('COACH_AI_DAILY_CALLS'), total = limit('COACH_AI_TOTAL_CALLS');
    if (!daily && !total) throw new Error('AI allowance not configured');
    const name = '/data/coach-ai-budget.json', day = new Date(now()).toISOString().slice(0, 10);
    const exists = fs.existsSync(name);
    const budget = exists ? JSON.parse(fs.readFileSync(name, 'utf8')) : { used: 0, totalUsed: 0 };
    const used = budget.day === day ? budget.used : 0;
    // Legacy daily-only records cannot establish historical spend. Refuse a new
    // total allowance rather than silently resetting it during migration.
    const totalUsed = budget.totalUsed ?? (total && exists ? NaN : 0);
    if (![used, totalUsed].every(n => Number.isSafeInteger(n) && n >= 0)
      || (daily && used >= daily) || (total && totalUsed >= total)) throw new Error('AI allowance exhausted');
    fs.writeFileSync(name, JSON.stringify({ day, used: used + 1, totalUsed: totalUsed + 1 }));
  };
}
