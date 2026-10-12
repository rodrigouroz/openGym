import * as cfgStore from './config.js';
import * as jobs from './jobs.js';
import { computeCohort } from './cohort.js';
import { adapterFor } from './adapters/index.js';
import { canDropPrivileges } from './adapters/spawn.js';

import { createCoachRoutes } from './routes-service.js';
export const { coachRoutes } = createCoachRoutes({ cfgStore, jobs, computeCohort, adapterFor, canDropPrivileges, env: process.env });
