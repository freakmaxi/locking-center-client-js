// Wire format of a Locking-Center request. One request is one TCP connection:
// connect, write these bytes, read exactly one answer byte, close.
//
//   1 = Lock            [1][keySize][key][sourceSize][source]
//   2 = Unlock          [2][keySize][key]
//   3 = ResetByKey      [3][keySize][key]
//   4 = ResetBySource   [4][sourceSize][source]
//   5 = TryLock         [5][keySize][key][sourceSize][source]
//
// Strings are length-prefixed: one byte holding the byte length, then the raw
// bytes. The server reads the size as a signed byte, so 127 is the largest key
// or source a request can carry.

export const Action = Object.freeze({
  Lock: 1,
  Unlock: 2,
  ResetByKey: 3,
  ResetBySource: 4,
  TryLock: 5,
});

export const Answer = Object.freeze({
  Success: '+',
  Failure: '-',
  NotAcquired: '#',
});

// The largest key or source address a request can carry. Anything above it can
// never be sent and is a caller mistake, not a transient failure.
export const MAX_VALUE_SIZE = 127;

/**
 * Fails fast on a key that can never succeed, rather than letting the
 * retry loops spin on it forever. Runs before any network I/O.
 *
 * @param {unknown} key
 * @throws {TypeError} when the key is not a string
 * @throws {RangeError} when the key is empty or longer than 127 UTF-8 bytes
 */
export function checkKey(key) {
  if (typeof key !== 'string') {
    throw new TypeError('locking-center: key must be a string');
  }
  const size = Buffer.byteLength(key, 'utf8');
  if (size === 0) {
    throw new RangeError('locking-center: key can not be empty');
  }
  if (size > MAX_VALUE_SIZE) {
    throw new RangeError(`locking-center: key can not be longer than ${MAX_VALUE_SIZE} bytes`);
  }
}

/**
 * Validates an optional source address. `undefined`, `null` and the empty
 * string all mean "let the server use the connection's peer address".
 *
 * @param {unknown} source
 * @throws {TypeError} when the source is neither a string nor null/undefined
 * @throws {RangeError} when the source is longer than 127 UTF-8 bytes
 */
export function checkSource(source) {
  if (source === undefined || source === null) return;
  if (typeof source !== 'string') {
    throw new TypeError('locking-center: source address must be a string');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_VALUE_SIZE) {
    throw new RangeError(`locking-center: source address can not be longer than ${MAX_VALUE_SIZE} bytes`);
  }
}

/**
 * Encodes a string as [byteLength][utf8 bytes]. The size prefix must be the
 * number of bytes that follow, so it is taken from the UTF-8 encoding
 * (Buffer.byteLength), not from `value.length` which counts UTF-16 code
 * units. For a non-ASCII key the two differ and the server would read a
 * truncated key and desync on the rest of the packet.
 *
 * @param {string} value
 * @returns {Buffer}
 */
export function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_VALUE_SIZE) {
    throw new RangeError(`locking-center: value can not be longer than ${MAX_VALUE_SIZE} bytes`);
  }
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

/**
 * Builds the request bytes for an action.
 *
 * @param {number} action one of {@link Action}
 * @param {string} [key] required for Lock, TryLock, Unlock and ResetByKey
 * @param {string|null} [source] optional for Lock, TryLock and ResetBySource
 * @returns {Buffer}
 */
export function preparePackage(action, key = '', source = null) {
  const parts = [Buffer.from([action])];

  switch (action) {
    case Action.Lock:
    case Action.TryLock:
    case Action.Unlock:
    case Action.ResetByKey:
      parts.push(encodeString(key));
      break;
    case Action.ResetBySource:
      break;
    default:
      throw new RangeError(`locking-center: unknown action ${action}`);
  }

  switch (action) {
    case Action.Lock:
    case Action.TryLock:
    case Action.ResetBySource:
      parts.push(encodeString(source ?? ''));
      break;
  }

  return Buffer.concat(parts);
}
