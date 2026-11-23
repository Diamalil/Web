'use strict';

const session = require('express-session');

const TABLE = 'feeku_server_sessions';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SupabaseSessionStore extends session.Store {
  constructor(options = {}) {
    super();

    this.url = String(options.url || '').replace(/\/+$/, '');
    this.apiKey = String(options.apiKey || '');
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Number(options.timeoutMs) || 8000;
    this.defaultTtlMs = Number(options.defaultTtlMs) || DEFAULT_TTL_MS;

    if (!/^https:\/\//i.test(this.url)) {
      throw new Error('Supabase session store requires an HTTPS project URL.');
    }
    if (!this.apiKey) {
      throw new Error('Supabase session store requires a server-side secret key.');
    }
    if (typeof this.fetch !== 'function') {
      throw new Error('Supabase session store requires fetch support.');
    }
  }

  expirationFor(sess) {
    const cookie = sess && sess.cookie ? sess.cookie : {};
    if (cookie.expires) {
      const expiresAt = new Date(cookie.expires).getTime();
      if (Number.isFinite(expiresAt)) return expiresAt;
    }

    const maxAge = Number(cookie.originalMaxAge ?? cookie.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;
    return Date.now() + this.defaultTtlMs;
  }

  async request(method, params = {}, body, extraHeaders = {}) {
    const query = new URLSearchParams(params).toString();
    const endpoint = this.url + '/rest/v1/' + TABLE + (query ? '?' + query : '');
    const headers = {
      apikey: this.apiKey,
      Authorization: 'Bearer ' + this.apiKey,
      Accept: 'application/json',
      ...extraHeaders
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.fetch(endpoint, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const raw = await response.text();

    if (!response.ok) {
      throw new Error('Supabase session store request failed (' + response.status + ').');
    }

    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        throw new Error('Supabase session store returned an invalid response.');
      }
    }
    return { data, response };
  }

  complete(callback, promise) {
    const done = typeof callback === 'function' ? callback : () => {};
    Promise.resolve(promise).then(
      value => done(null, value),
      error => done(error)
    );
  }

  get(sid, callback) {
    const promise = this.request('GET', {
      select: 'sess,expire',
      sid: 'eq.' + sid,
      limit: '1'
    }).then(async ({ data }) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || !row.sess || typeof row.sess !== 'object') return null;

      const expiresAt = new Date(row.expire).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await this.request('DELETE', { sid: 'eq.' + sid }).catch(() => {});
        return null;
      }
      return row.sess;
    });

    this.complete(callback, promise);
  }

  set(sid, sess, callback) {
    const expiresAt = this.expirationFor(sess);
    const promise = (async () => {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await this.request('DELETE', { sid: 'eq.' + sid });
        return;
      }

      await this.request('POST', { on_conflict: 'sid' }, {
        sid,
        sess,
        expire: new Date(expiresAt).toISOString()
      }, {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      });

      // Expiry enforcement happens on reads; this opportunistic cleanup bounds stale rows.
      await this.purge().catch(() => {});
    })();

    this.complete(callback, promise);
  }

  touch(sid, sess, callback) {
    const expiresAt = this.expirationFor(sess);
    const promise = this.request('PATCH', { sid: 'eq.' + sid }, {
      expire: new Date(expiresAt).toISOString()
    }, {
      Prefer: 'return=minimal'
    });
    this.complete(callback, promise);
  }

  destroy(sid, callback) {
    this.complete(callback, this.request('DELETE', { sid: 'eq.' + sid }));
  }

  clear(callback) {
    this.complete(callback, this.request('DELETE', { sid: 'not.is.null' }));
  }

  length(callback) {
    const promise = this.request('GET', {
      select: 'sid',
      expire: 'gt.' + new Date().toISOString()
    }, undefined, {
      Prefer: 'count=exact',
      Range: '0-0'
    }).then(({ data, response }) => {
      const contentRange = response.headers && response.headers.get
        ? response.headers.get('content-range')
        : null;
      const totalText = contentRange && contentRange.split('/')[1];
      const total = totalText === '*' ? 0 : Number(totalText);
      return Number.isFinite(total) ? total : (Array.isArray(data) ? data.length : 0);
    });

    this.complete(callback, promise);
  }

  all(callback) {
    const promise = this.request('GET', {
      select: 'sess',
      expire: 'gt.' + new Date().toISOString()
    }).then(({ data }) => Array.isArray(data)
      ? data.map(row => row.sess).filter(sess => sess && typeof sess === 'object')
      : []);

    this.complete(callback, promise);
  }

  purge() {
    return this.request('DELETE', {
      expire: 'lt.' + new Date().toISOString()
    }).then(() => true);
  }
}

module.exports = SupabaseSessionStore;
