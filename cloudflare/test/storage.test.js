import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStorage } from '../storage.js';

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: { exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) {
      db.exec('SAVEPOINT document_write');
      try { const result = fn(); db.exec('RELEASE document_write'); return result; }
      catch (e) { db.exec('ROLLBACK TO document_write; RELEASE document_write'); throw e; }
    }
  };
  return { db, storage, fs: createStorage(storage) };
}

test('5 MiB Unicode document survives reopening; shrinking removes trailing chunks', t => {
  const { storage, fs, db } = database(t);
  const value = JSON.stringify({ unknown: '🏋️'.repeat(740000) });
  assert.ok(Buffer.byteLength(value) > 5 * 1024 * 1024 - 100000);
  fs.writeFileSync('/data/state-test.json', value);
  assert.equal(createStorage(storage).readFileSync('/data/state-test.json', 'utf8'), value);
  assert.ok(db.prepare('SELECT max(length(bytes)) n FROM chunks').get().n <= 512 * 1024);
  fs.writeFileSync('/data/state-test.json', '{}');
  assert.equal(fs.readFileSync('/data/state-test.json', 'utf8'), '{}');
  assert.equal(db.prepare('SELECT count(*) n FROM chunks').get().n, 1);
});

test('failed replacement rolls back metadata and all chunks and invokes the failure handler', t => {
  const { storage, fs } = database(t);
  fs.writeFileSync('/data/db.json', '{"users":[{"id":"retained"}]}');
  let failures = 0;
  const guarded = createStorage(storage, () => failures++);
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT INTO chunks') && args[1] === 1) throw new Error('storage full');
    return exec(query, ...args);
  };
  assert.throws(() => guarded.writeFileSync('/data/db.json', 'x'.repeat(1024 * 1024)), /storage full/);
  assert.equal(fs.readFileSync('/data/db.json', 'utf8'), '{"users":[{"id":"retained"}]}');
  assert.equal(failures, 1);
});

test('missing and incomplete documents are distinguished; copies, audit appends and deletions persist', t => {
  const { db, fs } = database(t);
  assert.throws(() => fs.readFileSync('missing'), { code: 'ENOENT' });
  fs.writeFileSync('secret', 'persistent-session-secret');
  fs.copyFileSync('secret', 'secret.bak');
  fs.appendFileSync('audit.log', 'one\n'); fs.appendFileSync('audit.log', 'two\n');
  assert.equal(fs.readFileSync('audit.log', 'utf8'), 'one\ntwo\n');
  assert.equal(fs.readFileSync('secret.bak', 'utf8'), 'persistent-session-secret');
  db.exec("DELETE FROM chunks WHERE name = 'secret'");
  assert.throws(() => fs.readFileSync('secret'), /Incomplete document/);
  fs.unlinkSync('secret.bak');
  assert.equal(fs.existsSync('secret.bak'), false);
});
