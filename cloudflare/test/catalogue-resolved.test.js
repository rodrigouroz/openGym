import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Guards the packaging side of GET /api/data?resolve=1 on Cloudflare: Wrangler must inline
// api/catalogue.json into build/worker.js. An empty catalogue at runtime means this import was
// dropped or app.js still reads the file through the Durable Object filesystem.
test('Worker bundle includes the exercise catalogue JSON', () => {
  const app = readFileSync(resolve('..', 'api', 'app.js'), 'utf8');
  assert.match(app, /import bundledCatalogue from '\.\/catalogue\.json' with \{ type: 'json' \}/,
    'app.js must statically import catalogue.json so Wrangler can bundle it');
  assert.doesNotMatch(app, /readFileSync\([^)]*catalogue\.json/,
    'app.js must not load catalogue.json via injectable fs (empty on the Worker DO path)');

  const bundle = readFileSync(resolve('build', 'worker.js'), 'utf8');
  assert.ok(bundle.includes('barbell bench press'), 'bench press name missing from Worker bundle');
  assert.ok(bundle.includes('band single leg reverse calf raise'), 'catalogue sample missing from Worker bundle');
  // Rough lower bound: the shipped catalogue has thousands of primaryMuscles entries.
  const hits = bundle.match(/primaryMuscles/g)?.length || 0;
  assert.ok(hits > 1000, `Worker bundle catalogue looks empty (primaryMuscles hits=${hits})`);
});
