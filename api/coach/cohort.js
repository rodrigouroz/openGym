import * as cfgStore from './config.js';
import { readState, listUserIds, isSharing } from './jobs.js';

import { createCoachCohort } from './cohort-service.js';
export const { MIN_PEOPLE, MAX_EXERCISES, invalidate, computeCohort, cohortForPayload } = createCoachCohort({ cfgStore, readState: (...a) => readState(...a), listUserIds: (...a) => listUserIds(...a), isSharing: (...a) => isSharing(...a) });
