import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { createStorage } from './storage.js';

const CHUNK = 512 * 1024;
// The media parser/streamer uses only this small POSIX-shaped surface. Uploads
// stream into temporary chunk rows and become visible by an atomic rename after
// the existing size/hash/type validation. No complete video is buffered in RAM.
export function createFiles(storage, onFailure) {
  const docs = createStorage(storage, onFailure);
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS directories (name TEXT PRIMARY KEY)');
  const fds = new Map(); let nextFd = 1;
  const file = fd => typeof fd === 'number' ? fds.get(fd)?.name : fd;
  const directory = name => sql.exec('SELECT name FROM directories WHERE name = ?', name).toArray().length > 0;
  const entry = (name, dir) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  const fs = { ...docs,
    mkdirSync(name) {
      for (let p = path.resolve(name); p !== '/'; p = path.dirname(p)) sql.exec('INSERT OR IGNORE INTO directories VALUES (?)', p);
    },
    existsSync: name => directory(name) || docs.existsSync(name),
    statSync: name => directory(name) ? { size: 0, mtimeMs: 0, ...entry(name, true) } : { ...docs.statSync(name), ...entry(name, false) },
    readdirSync(name, options = {}) {
      const prefix = name.replace(/\/$/, '') + '/';
      const rows = [...sql.exec('SELECT name FROM documents').toArray(), ...sql.exec('SELECT name FROM directories').toArray()];
      const names = [...new Set(rows.map(r => r.name).filter(n => n.startsWith(prefix) && n !== prefix)
        .map(n => n.slice(prefix.length).split('/')[0]))].filter(Boolean);
      return options.withFileTypes ? names.map(n => entry(n, directory(prefix + n))) : names;
    },
    openSync(name, flags = 'r') {
      if (flags.includes('x') && fs.existsSync(name)) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
      if (flags.startsWith('w')) docs.writeFileSync(name, '');
      else docs.statSync(name);
      const fd = nextFd++; fds.set(fd, { name, position: 0 }); return fd;
    },
    closeSync(fd) { fds.delete(fd); },
    fsyncSync() {}, // SQLite commits and DO output gates provide durability.
    fstatSync: fd => fs.statSync(file(fd)),
    writeFileSync: (name, content) => docs.writeFileSync(file(name), content),
    readSync(fd, target, offset, length, position) {
      const record = fds.get(fd); if (!record) throw new Error('Invalid file descriptor');
      const pos = position ?? record.position;
      const size = docs.statSync(record.name).size;
      const count = Math.max(0, Math.min(length, size - pos));
      if (!count) return 0;
      const start = Math.floor(pos / CHUNK), end = Math.floor((pos + count - 1) / CHUNK);
      const rows = sql.exec('SELECT part, bytes FROM chunks WHERE name = ? AND part >= ? AND part <= ? ORDER BY part', record.name, start, end).toArray();
      let copied = 0;
      for (const row of rows) {
        const bytes = Buffer.from(row.bytes), from = Math.max(0, pos - row.part * CHUNK);
        const n = Math.min(bytes.length - from, count - copied);
        if (n > 0) { bytes.copy(target, offset + copied, from, from + n); copied += n; }
      }
      if (copied !== count) throw new Error('Incomplete media file');
      if (position == null) record.position += count;
      return count;
    },
    createReadStream(name, options = {}) {
      const fd = options.fd ?? fs.openSync(name); let pos = 0;
      return new Readable({
        read() {
          try { const b = Buffer.alloc(CHUNK); const n = fs.readSync(fd, b, 0, CHUNK, pos); pos += n; this.push(n ? b.subarray(0, n) : null); }
          catch (e) { this.destroy(e); }
        },
        destroy(err, done) { fs.closeSync(fd); done(err); }
      });
    },
    createWriteStream(name, options = {}) {
      let pending = Buffer.alloc(CHUNK), filled = 0, part = 0, fd;
      const append = bytes => {
        try { storage.transactionSync(() => {
          sql.exec('INSERT INTO chunks VALUES (?, ?, ?)', name, part++, bytes);
          sql.exec('UPDATE documents SET size = size + ?, modified = ? WHERE name = ?', bytes.length, Date.now(), name);
        }); } catch(e) { onFailure?.(e); throw e; }
      };
      return new Writable({
        highWaterMark: options.highWaterMark || CHUNK,
        construct(done) { try { fd = fs.openSync(name, options.flags || 'w'); done(); } catch(e) { done(e); } },
        write(bytes, _encoding, done) {
          try {
            for (let offset = 0; offset < bytes.length;) {
              const n = Math.min(CHUNK - filled, bytes.length - offset);
              bytes.copy(pending, filled, offset, offset + n); offset += n; filled += n;
              if (filled === CHUNK) { append(pending); pending = Buffer.alloc(CHUNK); filled = 0; }
            }
            done();
          } catch(e) { done(e); }
        },
        final(done) { try { if (filled) append(pending.subarray(0, filled)); pending = null; done(); } catch(e) { done(e); } },
        destroy(err, done) { if (fd) fs.closeSync(fd); done(err); }
      });
    },
    rmSync(name) {
      for (const row of sql.exec('SELECT name FROM documents').toArray()) if (row.name === name || row.name.startsWith(name + '/')) docs.unlinkSync(row.name);
      for (const row of sql.exec('SELECT name FROM directories').toArray()) if (row.name === name || row.name.startsWith(name + '/')) sql.exec('DELETE FROM directories WHERE name = ?', row.name);
    },
    statfsSync() {
      const used = sql.exec('SELECT COALESCE(SUM(size), 0) size FROM documents').toArray()[0].size;
      return { bsize: 1, bavail: Math.max(0, 1_000_000_000 - used - 128 * 1024 ** 2) };
    }
  };
  return fs;
}
