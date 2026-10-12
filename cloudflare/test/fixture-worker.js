// Test-only entrypoint. It is never referenced by wrangler.jsonc or deployed.
import production, { Gym } from '../build/worker.js';
export class TestGym extends Gym {
  constructor(ctx, env) {
    const ai = { async run(_model, _input) {
      ctx.storage.sql.exec('INSERT INTO test_inferences DEFAULT VALUES');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { response: { coach_contract: 1, nochange: true, reading: 'Synthetic fixture review.' } };
    } };
    super(ctx, { ...env, AI: ai, COACH_AI_DAILY_CALLS: '10' });
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_inferences (id INTEGER PRIMARY KEY)');
  }
  info() {
    return { calls: this.sql.exec('SELECT count(*) n FROM test_inferences').toArray()[0].n,
      timers: this.sql.exec('SELECT count(*) n FROM rest_timers').toArray()[0].n };
  }
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/__test/info') return env.GYM.getByName('installation').info().then(Response.json);
  return production.fetch(request, env);
} };
