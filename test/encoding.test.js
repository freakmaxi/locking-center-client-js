import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Action,
  MAX_VALUE_SIZE,
  checkKey,
  checkSource,
  encodeString,
  preparePackage,
} from '../src/index.js';

const bytes = (buffer) => Array.from(buffer);

describe('preparePackage', () => {
  it('Lock without a source: [1][size][key][0]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.Lock, 'locking-me')),
      [1, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101, 0],
    );
  });

  it('Lock with a source: [1][size][key][size][source]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.Lock, 'locking-me', '10.0.0.4')),
      [1, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101, 8, 49, 48, 46, 48, 46, 48, 46, 52],
    );
  });

  it('TryLock without a source: [5][size][key][0]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.TryLock, 'locking-me')),
      [5, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101, 0],
    );
  });

  it('TryLock with a source: [5][size][key][size][source]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.TryLock, 'k', 'me')),
      [5, 1, 107, 2, 109, 101],
    );
  });

  it('Unlock: [2][size][key], no source even if one is given', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.Unlock, 'locking-me')),
      [2, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101],
    );
    assert.deepEqual(
      bytes(preparePackage(Action.Unlock, 'locking-me', 'ignored')),
      [2, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101],
    );
  });

  it('ResetByKey: [3][size][key]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.ResetByKey, 'locking-me')),
      [3, 10, 108, 111, 99, 107, 105, 110, 103, 45, 109, 101],
    );
  });

  it('ResetBySource with a source: [4][size][source]', () => {
    assert.deepEqual(
      bytes(preparePackage(Action.ResetBySource, '', '10.0.0.9')),
      [4, 8, 49, 48, 46, 48, 46, 48, 46, 57],
    );
  });

  it('ResetBySource without a source: [4][0]', () => {
    assert.deepEqual(bytes(preparePackage(Action.ResetBySource)), [4, 0]);
    assert.deepEqual(bytes(preparePackage(Action.ResetBySource, '', null)), [4, 0]);
    assert.deepEqual(bytes(preparePackage(Action.ResetBySource, '', '')), [4, 0]);
  });

  it('uses the UTF-8 byte count, not the string length, as the size prefix', () => {
    const key = 'café-ключ'; // 9 characters, 14 UTF-8 bytes
    assert.equal(key.length, 9);
    assert.equal(Buffer.byteLength(key, 'utf8'), 14);

    const packet = preparePackage(Action.Lock, key);
    assert.equal(packet[0], 1);
    assert.equal(packet[1], 14);
    assert.deepEqual(bytes(packet.subarray(2, 16)), bytes(Buffer.from(key, 'utf8')));
    assert.equal(packet[16], 0);
    assert.equal(packet.length, 17);
  });

  it('rejects an unknown action', () => {
    assert.throws(() => preparePackage(9, 'k'), RangeError);
  });
});

describe('encodeString', () => {
  it('prefixes the byte length', () => {
    assert.deepEqual(bytes(encodeString('')), [0]);
    assert.deepEqual(bytes(encodeString('ab')), [2, 97, 98]);
  });

  it('accepts exactly 127 bytes and rejects 128', () => {
    assert.equal(encodeString('x'.repeat(MAX_VALUE_SIZE)).length, MAX_VALUE_SIZE + 1);
    assert.throws(() => encodeString('x'.repeat(MAX_VALUE_SIZE + 1)), RangeError);
  });
});

describe('checkKey', () => {
  it('accepts 1..127 bytes', () => {
    assert.doesNotThrow(() => checkKey('a'));
    assert.doesNotThrow(() => checkKey('x'.repeat(127)));
  });

  it('rejects an empty key', () => {
    assert.throws(() => checkKey(''), RangeError);
  });

  it('rejects a key over 127 bytes, counted in UTF-8 bytes', () => {
    assert.throws(() => checkKey('x'.repeat(128)), RangeError);
    assert.throws(() => checkKey('x'.repeat(200)), RangeError);
    // 64 two-byte characters = 128 bytes, although only 64 chars long
    assert.throws(() => checkKey('é'.repeat(64)), RangeError);
    assert.doesNotThrow(() => checkKey('é'.repeat(63)));
  });

  it('rejects a non-string key', () => {
    assert.throws(() => checkKey(undefined), TypeError);
    assert.throws(() => checkKey(null), TypeError);
    assert.throws(() => checkKey(42), TypeError);
  });
});

describe('checkSource', () => {
  it('accepts null, undefined, empty and up to 127 bytes', () => {
    assert.doesNotThrow(() => checkSource(undefined));
    assert.doesNotThrow(() => checkSource(null));
    assert.doesNotThrow(() => checkSource(''));
    assert.doesNotThrow(() => checkSource('x'.repeat(127)));
  });

  it('rejects over 127 bytes and non-strings', () => {
    assert.throws(() => checkSource('x'.repeat(128)), RangeError);
    assert.throws(() => checkSource(42), TypeError);
  });
});
