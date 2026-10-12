import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as cfgStore from './config.js';
import { adapterFor } from './adapters/index.js';
import { handleFor } from './handle.js';
import { fetchFor } from './node-fetch.js';
import { canDropPrivileges, unprivilegedIds } from './adapters/spawn.js';
import { cohortForPayload, invalidate as invalidateCohort } from './cohort.js';

import { createCoachJobs } from './jobs-service.js';
export const { TIMEOUT_MS, readUser, clearUser, listUserIds, isSharing, setShare, readState, capState, status, clampMessage, enqueue, whyUnusable, setProposalHook, resolvePending, testRun, recoverOnBoot, hashPlan, buildPrompt, CoachError } = createCoachJobs({ fs, env: process.env, spawnSync, cfgStore, adapterFor, handleFor, fetchFor, canDropPrivileges, unprivilegedIds, cohortForPayload: (...a) => cohortForPayload(...a), invalidateCohort: (...a) => invalidateCohort(...a) });
