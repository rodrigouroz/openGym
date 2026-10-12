import * as jobs from './jobs.js';
import * as cfgStore from './config.js';
import { createCadence } from './cadence-service.js';
export const { isDue, startCadence } = createCadence({ jobs, cfgStore, setInterval: (...args) => globalThis.setInterval(...args) });
