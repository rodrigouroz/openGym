import crypto from 'node:crypto';
import { createCoachConfig } from '../api/coach/config-service.js';
import { createCoachJobs } from '../api/coach/jobs-service.js';
import { createCoachCohort } from '../api/coach/cohort-service.js';
import { createCoachRoutes } from '../api/coach/routes-service.js';
import { HTTP_PROVIDERS } from '../api/coach/core/providers.js';
import anthropic from '../api/coach/core/adapters/anthropic.js';
import openai from '../api/coach/core/adapters/openai.js';
import gemini from '../api/coach/core/adapters/gemini.js';
import compatible from '../api/coach/core/adapters/compatible.js';
import { workersAI, AI_PROVIDER } from './ai.js';

export function createCoach({ fs, env, defer, ai = env.AI, adapters = {} }) {
  const providers = { ...HTTP_PROVIDERS, ...(ai ? { 'workers-ai': AI_PROVIDER } : {}) };
  const cfgStore = createCoachConfig({ fs, env, providers });
  // Explicit deployment-level allowance, independent of user-editable job caps.
  // Reserve before each attempt (including repairs/tests); interruptions never refund.
  const reserve = () => {
    const limit = Number(env.COACH_AI_DAILY_CALLS || 0);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('AI allowance not configured');
    const name = '/data/coach-ai-budget.json', day = new Date().toISOString().slice(0, 10);
    const budget = fs.existsSync(name) ? JSON.parse(fs.readFileSync(name, 'utf8')) : {};
    const used = budget.day === day ? budget.used : 0;
    if (!Number.isSafeInteger(used) || used < 0 || used >= limit) throw new Error('AI allowance exhausted');
    fs.writeFileSync(name, JSON.stringify({ day, used: used + 1 }));
  };
  const all = { anthropic, openai, gemini, compatible, 'workers-ai': workersAI(ai, reserve), ...adapters };
  const adapterFor = id => all[id] || null;
  const unavailable = () => { throw new Error('CLI providers require Docker'); };
  const canDropPrivileges = () => ({ ok: false, why: 'CLI providers require Docker' });
  let cohort;
  const jobs = createCoachJobs({ fs, env, cfgStore, adapterFor, defer,
    spawnSync: unavailable, canDropPrivileges, unprivilegedIds: () => null,
    fetchFor: () => fetch,
    handleFor: uid => crypto.createHmac('sha256', fs.readFileSync('/data/secret', 'utf8').trim())
      .update('coach-handle:' + uid).digest('base64url').slice(0, 16),
    cohortForPayload: uid => cohort.cohortForPayload(uid), invalidateCohort: () => cohort.invalidate()
  });
  cohort = createCoachCohort({ cfgStore, readState: jobs.readState, listUserIds: jobs.listUserIds, isSharing: jobs.isSharing });
  const { coachRoutes } = createCoachRoutes({ cfgStore, jobs, computeCohort: cohort.computeCohort, adapterFor, canDropPrivileges, env });
  return { cfgStore, jobs, coachRoutes };
}
