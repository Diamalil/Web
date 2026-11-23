'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const SQLiteSessionStore = require('../sqlite-session-store');

function createStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feeku-sessions-'));
  const filename = path.join(directory, 'sessions.sqlite');
  const store = new SQLiteSessionStore(filename, { cleanupIntervalMs: 0 });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filename };
}

function invoke(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => {
      if (error) return reject(error);
      resolve(value);
    });
  });
}

test('reads existing connect-sqlite3 compatible session rows', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feeku-existing-sessions-'));
  const filename = path.join(directory, 'sessions.sqlite');
  const expected = {
    cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString() },
    userId: 'test-user'
  };
  const legacyDb = new Database(filename);
  legacyDb.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY, expired INTEGER, sess TEXT)');
  legacyDb.prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)')
    .run('existing-session', Date.now() + 60000, JSON.stringify(expected));
  legacyDb.close();

  const store = new SQLiteSessionStore(filename, { cleanupIntervalMs: 0 });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await invoke(store, 'get', 'existing-session'), expected);
});

test('persists, touches, lists, counts, and destroys sessions', async t => {
  const { store } = createStore(t);
  const original = {
    cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString() },
    userId: 'test-user'
  };

  await invoke(store, 'set', 'session-1', original);
  assert.deepEqual(await invoke(store, 'get', 'session-1'), original);
  assert.equal(await invoke(store, 'length'), 1);
  assert.deepEqual(await invoke(store, 'all'), [original]);

  const touched = {
    cookie: { originalMaxAge: 120000, expires: new Date(Date.now() + 120000).toISOString() },
    userId: 'test-user'
  };
  await invoke(store, 'touch', 'session-1', touched);
  assert.deepEqual(await invoke(store, 'get', 'session-1'), touched);

  await invoke(store, 'destroy', 'session-1');
  assert.equal(await invoke(store, 'get', 'session-1'), null);
  assert.equal(await invoke(store, 'length'), 0);
});

test('does not return expired sessions and purges them', async t => {
  const { store } = createStore(t);
  const expired = {
    cookie: { originalMaxAge: -1000, expires: new Date(Date.now() - 1000).toISOString() },
    userId: 'expired-user'
  };

  await invoke(store, 'set', 'expired-session', expired);
  assert.equal(await invoke(store, 'get', 'expired-session'), null);
  assert.equal(await invoke(store, 'length'), 0);
  assert.equal(store.purge(), 0);
});
