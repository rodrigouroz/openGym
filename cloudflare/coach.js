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
import { createAIBudget } from './budget.js';

export function createCoach({ fs, env, defer, ai = env.AI, adapters = {}, budget = createAIBudget(fs, env) }) {
  const providers = { ...(env.COACH_AI_ONLY === '1' ? {} : HTTP_PROVIDERS), ...(ai ? { 'workers-ai': { ...AI_PROVIDER, defaultModel: env.COACH_AI_MODEL || AI_PROVIDER.defaultModel } } : {}) };
  const cfgStore = createCoachConfig({ fs, env, providers });
  if (ai && env.COACH_AI_DEFAULT === '1' && !fs.existsSync('/data/coach.json'))
    cfgStore.save({ enabled: true, provider: 'workers-ai', maxOutputTokens: 8192 });
  const reserve = budget;
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
  const { coachRoutes } = createCoachRoutes({ cfgStore, jobs, computeCohort: cohort.computeCohort, adapterFor, canDropPrivileges, env, budgetStatus: ai ? budget.status : undefined });
  return { cfgStore, jobs, coachRoutes, budget };
}
