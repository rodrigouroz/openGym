import { Buffer } from 'node:buffer';

// A small document store with the synchronous operations the existing API uses.
// JSON formats and filenames stay unchanged. Split bytes (not Unicode characters)
// below SQLite's row limit, so a full 5 MiB profile still fits. Each replacement
// is one transaction; readers can never observe part of a document.
const CHUNK_BYTES = 512 * 1024;
export function createStorage(storage, onFailure = () => {}) {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS chunks (name TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (name, part))');
  const missing = name => Object.assign(new Error(`No such document: ${name}`), { code: 'ENOENT' });
  const write = (name, content) => {
    const bytes = Buffer.from(content);
    try {
      storage.transactionSync(() => {
        sql.exec('DELETE FROM chunks WHERE name = ?', name);
        sql.exec('INSERT OR REPLACE INTO documents VALUES (?, ?, ?)', name, bytes.length, Date.now());
        for (let offset = 0, part = 0; offset < bytes.length; offset += CHUNK_BYTES, part++) {
          sql.exec('INSERT INTO chunks VALUES (?, ?, ?)', name, part, bytes.subarray(offset, offset + CHUNK_BYTES));
        }
      });
    } catch (e) { onFailure(e); throw e; }
  };
  const read = (name, encoding) => {
    const doc = sql.exec('SELECT size FROM documents WHERE name = ?', name).toArray()[0];
    if (!doc) throw missing(name);
    const rows = sql.exec('SELECT bytes FROM chunks WHERE name = ? ORDER BY part', name).toArray();
    const bytes = Buffer.concat(rows.map(row => Buffer.from(row.bytes)));
    if (bytes.length !== doc.size) throw new Error(`Incomplete document: ${name}`);
    return encoding ? bytes.toString(encoding) : bytes;
  };
  return {
    // Documents have no directories or POSIX permissions. Access is through the DO only.
    mkdirSync() {}, chmodSync() {},
    readFileSync: read,
    writeFileSync: write,
    existsSync: name => sql.exec('SELECT name FROM documents WHERE name = ?', name).toArray().length !== 0,
    copyFileSync: (from, to) => write(to, read(from)),
    appendFileSync: (name, text) => {
      let previous;
      try { previous = read(name); } catch (e) { if (e.code !== 'ENOENT') throw e; previous = Buffer.alloc(0); }
      write(name, Buffer.concat([previous, Buffer.from(text)]));
    },
    statSync: name => {
      const row = sql.exec('SELECT size, modified FROM documents WHERE name = ?', name).toArray()[0];
      if (!row) throw missing(name);
      return { size: row.size, mtimeMs: row.modified };
    },
    unlinkSync: name => {
      try {
        storage.transactionSync(() => {
          sql.exec('DELETE FROM chunks WHERE name = ?', name);
          sql.exec('DELETE FROM documents WHERE name = ?', name);
        });
      } catch (e) { onFailure(e); throw e; }
    }
  };
}
