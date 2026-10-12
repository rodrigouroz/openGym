import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createFiles } from '../files.js';
import { createMediaStore, mediaLimits } from '../../api/media.js';
import { mp4, gif, sha, fakeReq } from '../../api/test/media-samples.mjs';

function setup(t, limits = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const storage = {
    sql: { exec(q, ...args) { const rows = db.prepare(q).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('SAVEPOINT tx'); try { const r = fn(); db.exec('RELEASE tx'); return r; }
      catch (e) { db.exec('ROLLBACK TO tx; RELEASE tx'); throw e; } }
  };
  const fs = createFiles(storage);
  const make = () => createMediaStore({ dir: '/data/uploads', fs, syncDir() {}, syncFile() {}, limits: { ...mediaLimits({}), ...limits } });
  return { fs, db, make, store: make() };
}

test('large video streams to chunks, validates a trailing moov, and streams back after reopening', async t => {
  const h = setup(t);
  const bytes = mp4({ mdatBytes: 39 * 1024 * 1024, moovAtEnd: true }), hash = sha(bytes);
  const r = await h.store.receive('a', hash, fakeReq(bytes, { declare: 'video/mp4', chunk: 700001 }));
  assert.equal(r.status, 201);
  assert.ok(h.db.prepare('SELECT max(length(bytes)) n FROM chunks').get().n <= 512 * 1024);
  const file = h.make().file('a', hash);
  assert.ok(file);
  const digest = createHash('sha256');
  for await (const chunk of h.fs.createReadStream(file.path)) digest.update(chunk);
  assert.equal(digest.digest('hex'), hash);
  assert.equal(h.make().file('b', hash), null);
});

test('failed validation removes temporary chunks; profile quota and conservative free space reject before writing', async t => {
  const h = setup(t, { quotaMB: 1 });
  const bytes = gif(10000);
  await assert.rejects(h.store.receive('a', '0'.repeat(64), fakeReq(bytes, { declare: 'image/gif' })), e => e.code === 'hash-mismatch');
  assert.equal(h.db.prepare('SELECT count(*) n FROM chunks').get().n, 0);
  const big = gif(2 * 1024 * 1024);
  await assert.rejects(h.store.receive('a', sha(big), fakeReq(big, { declare: 'image/gif' })), e => e.code === 'media-quota');
  h.db.prepare('INSERT INTO documents VALUES (?, ?, ?)').run('simulated-existing-usage', 900000000, Date.now());
  await assert.rejects(h.store.receive('a', sha(bytes), fakeReq(bytes, { declare: 'image/gif' })), e => e.code === 'storage-full');
  assert.equal(h.db.prepare('SELECT count(*) n FROM chunks').get().n, 0);
});
