'use strict';

const session = require('express-session');
const Database = require('better-sqlite3');

const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
  constructor(filename, options = {}) {
    super();

    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expired INTEGER,
        sess TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
    `);

    this.statements = {
      get: this.db.prepare('SELECT expired, sess FROM sessions WHERE sid = ?'),
      set: this.db.prepare(`
        INSERT INTO sessions (sid, expired, sess)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          expired = excluded.expired,
          sess = excluded.sess
      `),
      touch: this.db.prepare('UPDATE sessions SET expired = ?, sess = ? WHERE sid = ?'),
      destroy: this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
      clearExpired: this.db.prepare('DELETE FROM sessions WHERE expired IS NOT NULL AND expired <= ?'),
      all: this.db.prepare('SELECT sess FROM sessions WHERE expired IS NULL OR expired > ?'),
      length: this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expired IS NULL OR expired > ?')
    };

    const cleanupIntervalMs = options.cleanupIntervalMs === undefined
      ? DEFAULT_CLEANUP_INTERVAL_MS
      : Number(options.cleanupIntervalMs);
    this.cleanupTimer = null;
    if (Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.purge();
        } catch (_) {
          // Cleanup is best-effort; request-time expiry checks remain authoritative.
        }
      }, cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  expirationFor(sess) {
    const cookie = sess && sess.cookie ? sess.cookie : {};
    if (cookie.expires) {
      const expiresAt = new Date(cookie.expires).getTime();
      if (Number.isFinite(expiresAt)) return expiresAt;
    }

    const maxAge = Number(cookie.originalMaxAge);
    return Number.isFinite(maxAge) && maxAge > 0 ? Date.now() + maxAge : null;
  }

  get(sid, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      const row = this.statements.get.get(sid);
      if (!row) return done(null, null);
      if (row.expired !== null && Number(row.expired) <= Date.now()) {
        this.statements.destroy.run(sid);
        return done(null, null);
      }
      return done(null, JSON.parse(row.sess));
    } catch (error) {
      return done(error);
    }
  }

  set(sid, sess, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      this.statements.set.run(sid, this.expirationFor(sess), JSON.stringify(sess));
      return done(null);
    } catch (error) {
      return done(error);
    }
  }

  touch(sid, sess, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      this.statements.touch.run(this.expirationFor(sess), JSON.stringify(sess), sid);
      return done(null);
    } catch (error) {
      return done(error);
    }
  }

  destroy(sid, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      this.statements.destroy.run(sid);
      return done(null);
    } catch (error) {
      return done(error);
    }
  }

  clear(callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      this.db.prepare('DELETE FROM sessions').run();
      return done(null);
    } catch (error) {
      return done(error);
    }
  }

  length(callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      const row = this.statements.length.get(Date.now());
      return done(null, Number(row.count));
    } catch (error) {
      return done(error);
    }
  }

  all(callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    try {
      const rows = this.statements.all.all(Date.now());
      return done(null, rows.map(row => JSON.parse(row.sess)));
    } catch (error) {
      return done(error);
    }
  }

  purge() {
    return this.statements.clearExpired.run(Date.now()).changes;
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.db && this.db.open) this.db.close();
  }
}

module.exports = SQLiteSessionStore;
