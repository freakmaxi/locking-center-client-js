// Integration test against a real Locking-Center server over TCP.
//
// The server binary is taken from LOCKD_SERVER and bound to LOCKD_PORT
// (default 29700). The server also opens PORT+1 (manager) and PORT+2
// (metrics). Without LOCKD_SERVER the suite is skipped with a message.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { LockingCenter } from '../src/index.js';

// The server binary under test. Build it from the server repository with
// `go build -o lockd-server ./mutex` and point LOCKD_SERVER at it. Without it
// the integration suite is skipped with a message rather than failing.
const SERVER = process.env.LOCKD_SERVER || '';
const PORT = Number(process.env.LOCKD_PORT || 29700);
const ADDRESS = `127.0.0.1:${PORT}`;

let server = null;
let serverOutput = '';

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await sleep(50);
  }
  throw new Error(`server did not open ${port} within ${timeoutMs}ms\n${serverOutput}`);
}

async function timed(promise) {
  const start = process.hrtime.bigint();
  const value = await promise;
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, elapsedMs };
}

// Resolves with 'pending' if the promise has not settled within ms,
// otherwise with its value.
function settledWithin(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => 'pending')]);
}

const SKIP_REASON = existsSync(SERVER)
  ? false
  : 'integration tests need the server: build it with `go build -o lockd-server ./mutex` ' +
    'in the server repository and set LOCKD_SERVER=/path/to/lockd-server' +
    (SERVER ? ` (got ${SERVER})` : '');

describe('LockingCenter against a live server', { skip: SKIP_REASON }, () => {
  before(async () => {
    assert.equal(await canConnect(PORT), false, `port ${PORT} is already in use`);
    // Nothing listens yet, so the constructor's ping must fail here. Checked
    // before the spawn so no other port has to be touched for the case.
    await assert.rejects(LockingCenter.connect(ADDRESS), { code: 'ECONNREFUSED' });

    server = spawn(SERVER, [], {
      env: { PATH: process.env.PATH, BIND_ADDRESS: ADDRESS },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => (serverOutput += chunk));
    server.stderr.on('data', (chunk) => (serverOutput += chunk));
    server.on('exit', (code, signal) => {
      serverOutput += `\n[server exited code=${code} signal=${signal}]\n`;
    });

    await waitForPort(PORT, 10_000);
  });

  after(async () => {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    if ((await settledWithin(exited, 1_000)) === 'pending') {
      server.kill('SIGKILL');
      await exited;
    }
  });

  it('connect pings the server and resolves a client once it is up', async () => {
    const client = await LockingCenter.connect(ADDRESS);
    assert.ok(client instanceof LockingCenter);
    assert.equal(client.address, ADDRESS);
    assert.equal(client.source, null);
  });

  it('connect validates the address and the source before dialing', async () => {
    await assert.rejects(LockingCenter.connect('no-port'), TypeError);
    await assert.rejects(LockingCenter.connect(''), TypeError);
    await assert.rejects(LockingCenter.connect(ADDRESS, 'x'.repeat(128)), RangeError);
    await assert.rejects(LockingCenter.connect(ADDRESS, 42), TypeError);
  });

  it('lock acquires, tryLock on a held key returns false immediately, unlock frees it', async () => {
    const owner = await LockingCenter.connect(ADDRESS, 'owner-a');
    const other = await LockingCenter.connect(ADDRESS, 'owner-b');
    const key = 'integration/held';

    const lock = await timed(owner.lock(key));
    assert.equal(lock.value, undefined);

    // held by owner -> '#' -> false, and it must not sit in the queue
    const tried = await timed(other.tryLock(key));
    assert.equal(tried.value, false);
    assert.ok(tried.elapsedMs < 1000, `tryLock blocked for ${tried.elapsedMs}ms`);

    // the same owner does not get it twice either, held is held
    assert.equal(await owner.tryLock(key), false);

    await owner.unlock(key);

    // now free -> '+' -> true
    assert.equal(await other.tryLock(key), true);
    await other.unlock(key);
  });

  it('tryLock on a free key returns true and the lock is really held', async () => {
    const client = await LockingCenter.connect(ADDRESS);
    const key = 'integration/free';

    assert.equal(await client.tryLock(key), true);
    assert.equal(await client.tryLock(key), false);
    await client.unlock(key);
    assert.equal(await client.tryLock(key), true);
    await client.unlock(key);
  });

  it('lock blocks while another owner holds the key and resumes on unlock', async () => {
    const a = await LockingCenter.connect(ADDRESS, 'blocker');
    const b = await LockingCenter.connect(ADDRESS, 'waiter');
    const key = 'integration/queue';

    await a.lock(key);

    const waiting = b.lock(key);
    assert.equal(await settledWithin(waiting, 700), 'pending', 'lock returned while the key was held');

    await a.unlock(key);
    assert.equal(await settledWithin(waiting, 3_000), undefined, 'lock did not resume after unlock');

    assert.equal(await a.tryLock(key), false, 'waiter should now hold the key');
    await b.unlock(key);
  });

  it('wait returns once the key is free and leaves it free', async () => {
    const a = await LockingCenter.connect(ADDRESS);
    const b = await LockingCenter.connect(ADDRESS);
    const key = 'integration/wait';

    await a.lock(key);
    const waiting = b.wait(key);
    assert.equal(await settledWithin(waiting, 500), 'pending');

    await a.unlock(key);
    assert.equal(await settledWithin(waiting, 3_000), undefined);

    assert.equal(await a.tryLock(key), true, 'wait must not keep the key');
    await a.unlock(key);
  });

  it('a non-ASCII key round-trips (UTF-8 byte-count size prefix)', async () => {
    const a = await LockingCenter.connect(ADDRESS);
    const b = await LockingCenter.connect(ADDRESS);
    const key = 'café-ключ';
    assert.notEqual(key.length, Buffer.byteLength(key, 'utf8'));

    await a.lock(key);
    // A truncated key would leave "café-ключ" itself free, so this proves the
    // server saw the whole key, not just the first key.length bytes.
    assert.equal(await b.tryLock(key), false);
    await a.unlock(key);
    assert.equal(await b.tryLock(key), true);
    await b.unlock(key);
  });

  it('an empty key and a 200-byte key fail fast without any network call', async () => {
    const client = await LockingCenter.connect(ADDRESS);
    const longKey = 'x'.repeat(200);

    const realConnect = net.connect;
    let connections = 0;
    net.connect = (...args) => {
      connections += 1;
      return realConnect(...args);
    };

    try {
      for (const key of ['', longKey]) {
        await assert.rejects(client.lock(key), RangeError);
        await assert.rejects(client.tryLock(key), RangeError);
        await assert.rejects(client.unlock(key), RangeError);
        await assert.rejects(client.wait(key), RangeError);
        await assert.rejects(client.resetByKey(key), RangeError);
      }
      await assert.rejects(client.resetBySource('s'.repeat(200)), RangeError);
      await assert.rejects(client.lock(undefined), TypeError);
      await assert.rejects(client.tryLock(null), TypeError);
    } finally {
      net.connect = realConnect;
    }

    assert.equal(connections, 0, 'validation must happen before any I/O');
  });

  it('validation rejects synchronously, before the first await', async () => {
    const client = await LockingCenter.connect(ADDRESS);
    const promise = client.lock('');
    // an already-rejected promise settles before a queued microtask
    const outcome = await Promise.race([
      promise.then(() => 'resolved', () => 'rejected'),
      Promise.resolve().then(() => Promise.resolve()).then(() => 'pending'),
    ]);
    assert.equal(outcome, 'rejected');
  });

  it('resetByKey force releases a key held by someone else', async () => {
    const holder = await LockingCenter.connect(ADDRESS, 'holder');
    const operator = await LockingCenter.connect(ADDRESS, 'operator');
    const key = 'integration/reset-key';

    await holder.lock(key);
    assert.equal(await operator.tryLock(key), false);

    await operator.resetByKey(key);
    assert.equal(await operator.tryLock(key), true);
    await operator.unlock(key);
  });

  it('resetBySource force releases everything one source held', async () => {
    const crashed = await LockingCenter.connect(ADDRESS, 'pod-10.0.0.9');
    const survivor = await LockingCenter.connect(ADDRESS, 'pod-10.0.0.4');
    const operator = await LockingCenter.connect(ADDRESS, 'operator');

    await crashed.lock('integration/rs-1');
    await crashed.lock('integration/rs-2');
    await survivor.lock('integration/rs-3');

    await operator.resetBySource('pod-10.0.0.9');

    assert.equal(await operator.tryLock('integration/rs-1'), true);
    assert.equal(await operator.tryLock('integration/rs-2'), true);
    assert.equal(await operator.tryLock('integration/rs-3'), false, 'other sources must be untouched');

    await operator.unlock('integration/rs-1');
    await operator.unlock('integration/rs-2');
    await survivor.unlock('integration/rs-3');

    // no source at all is also accepted (matches the peer address)
    await operator.resetBySource();
  });

  it('a shared client instance is safe for concurrent use', async () => {
    const client = await LockingCenter.connect(ADDRESS);
    const key = 'integration/concurrent';
    let inside = 0;
    let maxInside = 0;
    let done = 0;

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await client.lock(key);
        try {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(20);
          inside -= 1;
          done += 1;
        } finally {
          await client.unlock(key);
        }
      }),
    );

    assert.equal(done, 8);
    assert.equal(maxInside, 1, 'only one holder at a time');
  });
});
