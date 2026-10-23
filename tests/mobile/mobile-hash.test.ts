import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as nodeHash } from 'node:crypto';
import { createHash } from '../../mobile/shims/crypto.ts';

test('mobile SHA-256 matches Node for block boundaries, Unicode and split binary updates', () => {
  for (const size of [0,1,3,55,56,63,64,65,127,128,1024,100000]) {
    const value = '认知星图\0😀'.repeat(size);
    assert.equal(createHash('sha256').update(value).digest('hex'), nodeHash('sha256').update(value).digest('hex'));
  }
  const bytes = Uint8Array.from({ length: 1025 }, (_, i) => i % 256);
  assert.equal(createHash('sha256').update(bytes.subarray(0, 55)).update(bytes.subarray(55)).digest('hex'), nodeHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => createHash('sha1'));
  const once = createHash('sha256'); once.digest('hex'); assert.throws(() => once.update('later')); assert.throws(() => once.digest('hex'));
});
