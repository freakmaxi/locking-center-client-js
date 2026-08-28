import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { Action, Answer, checkKey, checkSource, preparePackage } from './packet.js';

// Delay between attempts of the keep-trying calls, so a down server or a
// rejected request does not turn the loop into a busy wait. A successful lock
// blocks on the server rather than spinning here, so the delay is only ever
// paid on failure.
export const QUEUE_RETRY_DURATION_MS = 500;

/**
 * Splits "host:port" into its parts. The last colon separates the port so a
 * bracketed IPv6 literal such as "[::1]:22119" also works.
 *
 * @param {string} address
 * @returns {{ host: string, port: number }}
 */
function parseAddress(address) {
  if (typeof address !== 'string' || address.length === 0) {
    throw new TypeError('locking-center: address must be a "host:port" string');
  }
  const index = address.lastIndexOf(':');
  if (index <= 0 || index === address.length - 1) {
    throw new TypeError('locking-center: address must be in "host:port" format');
  }
  let host = address.slice(0, index);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(address.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('locking-center: address port must be an integer between 1 and 65535');
  }
  return { host, port };
}

const CONSTRUCTOR_KEY = Symbol('LockingCenter.connect');

/**
 * A client for a Locking-Center server. Create one with
 * {@link LockingCenter.connect}; the instance is safe to share, every call
 * opens its own short-lived TCP connection so there is no shared socket state.
 */
export class LockingCenter {
  #host;
  #port;
  #source;

  /** @private Use {@link LockingCenter.connect}. */
  constructor(token, host, port, source) {
    if (token !== CONSTRUCTOR_KEY) {
      throw new TypeError('locking-center: use LockingCenter.connect(address, source) to create a client');
    }
    this.#host = host;
    this.#port = port;
    this.#source = source ?? null;
  }

  /**
   * Creates a client and dials the server once to make sure it is reachable.
   *
   * @param {string} address "host:port" of the Locking-Center server
   * @param {string|null} [source] identifies this owner for crash recovery
   *   (resetBySource). Omit to let the server use the connection's peer IP.
   * @returns {Promise<LockingCenter>} rejects when the server is unreachable,
   *   the address is malformed or the source is longer than 127 bytes
   */
  static async connect(address, source = null) {
    const { host, port } = parseAddress(address);
    checkSource(source);

    const client = new LockingCenter(CONSTRUCTOR_KEY, host, port, source);
    await client.#ping();
    return client;
  }

  /** The "host:port" this client talks to. */
  get address() {
    return `${this.#host}:${this.#port}`;
  }

  /** The source address given at connect time, or null. */
  get source() {
    return this.#source;
  }

  /** Dials once and closes; rejects with the connection error if it fails. */
  #ping() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.#host, port: this.#port });
      socket.once('connect', () => {
        socket.end();
        socket.destroy();
        resolve();
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  /**
   * One request on one fresh connection. Resolves with the single answer
   * character ('+', '-' or '#') or with `null` on any connection failure. It
   * never rejects and it never times out: for Lock the server keeps the
   * connection open, unboundedly, while the request waits in the queue.
   *
   * @param {number} action
   * @param {string} key
   * @param {string|null} source
   * @returns {Promise<string|null>}
   */
  #query(action, key, source) {
    const payload = preparePackage(action, key, source);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(answer);
      };

      const socket = net.connect({ host: this.#host, port: this.#port });
      socket.setNoDelay(true);

      socket.once('connect', () => {
        socket.write(payload);
      });
      socket.once('data', (chunk) => {
        finish(chunk.length > 0 ? String.fromCharCode(chunk[0]) : null);
      });
      // A connection that closes without sending an answer is a failure.
      socket.once('end', () => finish(null));
      socket.once('close', () => finish(null));
      socket.once('error', () => finish(null));
    });
  }

  /** Retries a query after a fixed delay until the server answers '+'. */
  async #retry(action, key, source) {
    while ((await this.#query(action, key, source)) !== Answer.Success) {
      await sleep(QUEUE_RETRY_DURATION_MS);
    }
  }

  /**
   * Acquires the key, waiting in the server's queue until it is free. Keeps
   * trying through connection failures, so it resolves only once the key is
   * held. The key is validated before any I/O: an empty or over-long key
   * rejects immediately.
   *
   * @param {string} key 1..127 UTF-8 bytes
   * @returns {Promise<void>}
   */
  async lock(key) {
    checkKey(key);
    await this.#retry(Action.Lock, key, this.#source);
  }

  /**
   * Attempts the lock once and resolves immediately, unlike lock which waits
   * until the key is free. Resolves true when the key was acquired and false
   * when it is held by somebody else or the server could not be reached, so
   * the caller decides whether to retry, wait or do something else.
   *
   * @param {string} key 1..127 UTF-8 bytes
   * @returns {Promise<boolean>}
   */
  async tryLock(key) {
    checkKey(key);
    return (await this.#query(Action.TryLock, key, this.#source)) === Answer.Success;
  }

  /**
   * Releases the key so the next queued request, if any, acquires it. Retries
   * every 500 ms until the server confirms. The key is validated before any
   * I/O: an empty or over-long key rejects immediately.
   *
   * @param {string} key 1..127 UTF-8 bytes
   * @returns {Promise<void>}
   */
  async unlock(key) {
    checkKey(key);
    await this.#retry(Action.Unlock, key, null);
  }

  /**
   * Waits until the key is free, then releases it right away without keeping
   * it. It is {@link lock} followed by {@link unlock}: a way to pause until
   * whoever holds the key is done, when there is no work of your own to
   * protect.
   *
   * @param {string} key 1..127 UTF-8 bytes
   * @returns {Promise<void>}
   */
  async wait(key) {
    await this.lock(key);
    await this.unlock(key);
  }

  /**
   * Force releases the key no matter who holds it and lets the queued requests
   * contend for it again. A lock is not tied to its connection, so a client
   * that crashes while holding a key leaves it locked; this is how an operator
   * or a supervisor clears such a stuck lock. Retries every 500 ms until the
   * server confirms.
   *
   * @param {string} key 1..127 UTF-8 bytes
   * @returns {Promise<void>}
   */
  async resetByKey(key) {
    checkKey(key);
    await this.#retry(Action.ResetByKey, key, null);
  }

  /**
   * Force releases every key held by the owner identified by `source`, the
   * address a client was connected with. It is the recovery path for a whole
   * instance that went away, on Kubernetes typically a crashed pod's IP. Omit
   * the source to let the server fall back to this connection's peer IP.
   * Retries every 500 ms until the server confirms.
   *
   * @param {string|null} [source] at most 127 UTF-8 bytes
   * @returns {Promise<void>}
   */
  async resetBySource(source = null) {
    checkSource(source);
    await this.#retry(Action.ResetBySource, '', source);
  }
}
