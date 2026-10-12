import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApiServer } from '../api/app.js';
import { createStorage } from './storage.js';
import { checkAccess } from './access.js';

// One existing openGym installation is the coordination unit: account creation,
// session revocation, and admin operations span all its profiles. Do not shard it
// by user without first changing those invariants in the API.
export class Gym extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const fs = createStorage(ctx.storage, () => ctx.abort('Persistent storage failed; reload the account database'));
    const noop = () => {};
    this.server = createApiServer({
      fs, durableWrite: fs.writeFileSync,
      env: { ...env, DATA_DIR: '/data', MEDIA_UPLOADS: '0', PASSWORD_LOGIN: '0' },
      background: false,
      coachConfig: { publicConfig: () => null, clearProfileAuth: noop },
      coachJobs: { recoverOnBoot: noop, setProposalHook: noop },
      coachRoutes: () => ({}), startCadence: noop, startWarmup: noop
    });
    this.http = httpServerHandler(this.server);
  }
  async fetch(request) {
    // Background push schedules need alarms; do not accept jobs that cannot run.
    if (new URL(request.url).pathname.startsWith('/api/push/')) return new Response('Unavailable on this deployment', { status: 404 });
    return this.http.fetch(request);
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
