# Locking-Center JavaScript Client

The Node.js connector for [Locking-Center](https://github.com/freakmaxi/locking-center), a mutex point that
synchronizes access to shared resources between different services. Lock a key before you touch the resource, do the
work, unlock the key. Only one caller holds a given key at a time, the rest queue up and are served in order.

- [Locking-Center Server](https://github.com/freakmaxi/locking-center)

This is a **Node.js** library, not a browser one. Locking-Center speaks raw TCP and browsers cannot open TCP sockets,
so the client is built on Node's `net` module and has no external dependencies. It is an ES module (`"type": "module"`)
and needs Node 20 or newer.

## Installation

```shell
npm install @freakmaxi/locking-center-client
```

## Quick start

```js
import { LockingCenter } from '@freakmaxi/locking-center-client';

const m = await LockingCenter.connect('localhost:22119');

await m.lock('locking-key');
try {
  console.log('Hello from the locked area!');
} finally {
  await m.unlock('locking-key');
}
```

## Why the API is Promise-based

Node is single-threaded and non-blocking: a call that waits on the network cannot block the thread the way the Go and
.NET clients do, or it would freeze everything else in the process. So every method returns a `Promise` and you `await`
it. `await m.lock(key)` suspends only the caller until the key is held; the event loop, and the rest of your program,
keeps running. The examples use top-level `await`, which works in any ES module; inside CommonJS wrap the code in an
`async` function.

Because `lock` and `unlock` are separate awaits, put the unlock in a `finally` so the key is released even when the
work in between throws:

```js
await m.lock('orders/batch-7');
try {
  // ... exclusive work, may throw ...
} finally {
  await m.unlock('orders/batch-7');
}
```

## Connecting

```js
// simplest form
const m = await LockingCenter.connect('localhost:22119');

// with a source address, which identifies this owner for crash recovery, see below
const m = await LockingCenter.connect('localhost:22119', '10.0.0.4');
```

`connect` dials the server once to make sure it is reachable and rejects if it is not (with the underlying socket
error, for example `ECONNREFUSED`). It also rejects when the address is not `host:port` or the source is longer than
127 bytes. The resolved client is safe to keep and share across your whole program; every call opens its own
short-lived connection, so there is no shared socket state and nothing to close.

## API

| Method | Blocks | Description |
| --- | --- | --- |
| `lock(key)` | yes | Acquires the key, waiting in the queue until it is free |
| `tryLock(key) → boolean` | no | Acquires the key only if it is free right now, resolves whether it did |
| `unlock(key)` | no | Releases the key |
| `wait(key)` | yes | Waits for the key to be free, then releases it again without holding it |
| `resetByKey(key)` | no | Force releases a key, whoever holds it (crash recovery) |
| `resetBySource(source)` | no | Force releases everything a given owner held (crash recovery) |

All methods return a `Promise`. "Blocks" means the promise stays pending until the key is free; it never blocks the
event loop.

### Locking

`lock` waits until the key is free, then takes it. It keeps trying through connection failures, so it resolves only
once the key is held.

```js
await m.lock('orders/batch-7');
try {
  // ... exclusive work ...
} finally {
  await m.unlock('orders/batch-7');
}
```

### Try locking

`tryLock` is the non-blocking form. It takes the key only if it is free at that moment and resolves immediately, so
you decide what to do when somebody else holds it.

```js
if (await m.tryLock('orders/batch-7')) {
  try {
    // ... exclusive work ...
  } finally {
    await m.unlock('orders/batch-7');
  }
} else {
  // someone else holds it, skip, retry later, or do something else
}
```

`tryLock` resolves `false` when the key is held by another owner **and** when the server cannot be reached, so a
`false` means only "you did not get the lock". It never rejects for a network reason. If you need to tell the two
apart, check reachability separately.

### Waiting

`wait` resolves once the key is free and releases it immediately, without holding it. Use it to pause until whoever
holds the key is done.

```js
await m.wait('migration-done'); // resolves once the key is free
```

## Crash recovery: reset

A lock is not tied to its TCP connection, so a client that crashes while holding a key leaves that key locked. Nothing
releases it automatically. `reset` is how an operator or a supervisor clears such a stuck lock.

```js
await m.resetByKey('orders/batch-7'); // release this key, whoever holds it

await m.resetBySource('10.0.0.9');    // release everything 10.0.0.9 held
```

`resetBySource` matches on the **source address**. Pass the source when you connect
(`LockingCenter.connect(address, source)`) so that each owner is identifiable; on Kubernetes, pass the pod IP. Leaving
the source out lets the server fall back to the connection's peer address.

## Keys

A key must be **between 1 and 127 bytes**, counted in UTF-8 bytes, not characters: `'café-ключ'` is 9 characters but
14 bytes. Keys are otherwise arbitrary text. An empty or over-long key is a programming error, so the client
**rejects right away** with a `RangeError` (a `TypeError` for a non-string) before it opens a connection, instead of
hanging in the retry loop. The same applies to an over-long source for `resetBySource`.

## Behaviour to know

- **`lock`, `unlock` and the resets keep retrying until they succeed.** They do not reject for network reasons; a
server that is down just means the promise stays pending and the call keeps trying (with a 500ms delay between
attempts). Race the promise against a timer (`Promise.race`, `AbortSignal.timeout` and friends) if you need to give
up. Only validation errors, see Keys, make them reject.
- **There is no read timeout on `lock`.** The server holds the connection open for as long as the key is held by its
current owner, which is unbounded. The client already accounts for this.
- **Every call is one short-lived TCP connection.** There is no pool to manage and nothing to close. A pending `lock`
keeps the Node process alive until it resolves, as any open socket does.
- **The client is safe for concurrent use.** Share one instance across your whole program and call it from as many
concurrent tasks as you like.
- **Node only.** TCP is not available in browsers, so this package does not run there.

## Development

```shell
npm run build            # syntax check
npm run test:unit        # packet encoding tests
npm run test:integration # spawns a real server and talks to it over TCP
npm test                 # both
```

The integration test spawns the server binary given by `LOCKD_SERVER` on port `LOCKD_PORT` (default `29700`; the
server also opens the next two ports) and kills it when done.

### Getting a server for the tests

The integration suite starts a real server itself. Build it from the
[server repository](https://github.com/freakmaxi/locking-center) and point `LOCKD_SERVER` at it;

```shell
go build -o lockd-server ./mutex
LOCKD_SERVER=/path/to/lockd-server node --test
```

Without `LOCKD_SERVER` the integration suite is skipped with a message; the encoding tests always run. `LOCKD_PORT`
(default `29700`) picks the port the test server binds; it also takes the two ports above it.

## License

[Apache License 2.0](LICENSE). The Locking-Center server itself is licensed separately under the GPL-3.0; the
clients are permissive so they can be embedded in any service.
