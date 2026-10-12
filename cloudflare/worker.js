import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApiServer } from '../api/app.js';
import { createFiles } from './files.js';
import { checkAccess } from './access.js';
import { createCoach } from './coach.js';
import * as pushTransport from './push.js';
import { createCadence } from '../api/coach/cadence-service.js';

// One existing openGym installation is the coordination unit: account creation,
// session revocation, and admin operations span all its profiles. Do not shard it
// by user without first changing those invariants in the API.
export class Gym extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const fs = createFiles(ctx.storage, () => ctx.abort('Persistent storage failed; reload the account database'));
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS rest_timers (id TEXT PRIMARY KEY, uid TEXT, device TEXT, at INTEGER, lang TEXT)');
    const durableRestTimers = {
      schedule: (uid, device = '', sec, lang = 'en') => this.sql.exec('INSERT OR REPLACE INTO rest_timers VALUES (?, ?, ?, ?, ?)', uid + ':' + device, uid, device, Date.now() + sec * 1000, lang),
      cancel: (uid, device) => device ? this.sql.exec('DELETE FROM rest_timers WHERE uid = ? AND device = ?', uid, device) : this.sql.exec('DELETE FROM rest_timers WHERE uid = ?', uid)
    };
    const noop = () => {};
    this.coach = createCoach({ fs, env: { ...env, DATA_DIR: '/data' }, defer: () => { this.queued = true; } });
    const cadence = createCadence({ jobs: this.coach.jobs, cfgStore: this.coach.cfgStore,
      setInterval: fn => { this.cadenceTick = fn; return { unref() {} }; } });
    this.server = createApiServer({
      fs, durableWrite: fs.writeFileSync,
      env: { ...env, DATA_DIR: '/data' },
      background: false, durableRestTimers, pushTransport, checkPushEndpoint: pushTransport.pushEndpointError,
      mediaStorage: { fs, syncDir: noop, syncFile: noop },
      coachConfig: this.coach.cfgStore, coachJobs: this.coach.jobs,
      coachRoutes: this.coach.coachRoutes, startCadence: cadence.startCadence, startWarmup: noop
    });
    this.http = httpServerHandler(this.server);
  }
  async fetch(request) {
    const response = await this.http.fetch(request);
    await this.server.drainPushes();
    await this.schedule();
    return response;
  }
  async schedule() {
    const enabled = this.coach.cfgStore.isEnabled() && this.coach.cfgStore.isConnected();
    const media = this.sql.exec("SELECT name FROM documents WHERE name LIKE '/data/uploads/%' LIMIT 1").toArray().length > 0;
    const rest = this.sql.exec('SELECT MIN(at) at FROM rest_timers').toArray()[0].at;
    const delay = this.queued ? 1 : this.server.hasSubscriptions() ? 10000 : enabled ? 60000 : media ? 3600000 : Infinity;
    const next = Math.min(Date.now() + delay, rest ?? Infinity);
    this.queued = false;
    if (!Number.isFinite(next)) { await this.ctx.storage.deleteAlarm(); return; }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
  async alarm() {
    for (const timer of this.sql.exec('SELECT * FROM rest_timers WHERE at <= ?', Date.now()).toArray()) {
      // Claim before sending: an alarm retry must not duplicate a rest alert.
      this.sql.exec('DELETE FROM rest_timers WHERE id = ?', timer.id);
      await this.server.sendRestAlert(timer.uid, timer.device, timer.lang);
    }
    await this.server.backgroundTick();
    this.cadenceTick?.();
    await this.coach.jobs.runQueued();
    await this.server.drainPushes();
    await this.schedule();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // No alternate hostname may reach the application, even through a future route.
    const denied = await checkAccess(request, env);
    if (denied) return denied;
    if (url.pathname.startsWith('/api/')) return env.GYM.getByName('installation').fetch(request);
    return env.ASSETS.fetch(request);
  }
};
