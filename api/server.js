import fs from 'node:fs';
import { atomicWrite } from './durable.js';
import { createApiServer } from './app.js';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';
import { startWarmup } from './coach/warmup.js';

const server = createApiServer({ fs, durableWrite: atomicWrite, coachConfig, coachJobs,
  coachRoutes, startCadence, startWarmup });
server.listen(+(process.env.PORT || 3000), () => console.log(
  `gym-api on :${server.address().port} (rpID=${process.env.RP_ID || 'localhost'}, origin=${process.env.ORIGIN || 'http://localhost:8080'})`));
