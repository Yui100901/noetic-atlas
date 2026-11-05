import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectApplicationState,
  isApplicationActive,
  onApplicationStateChange,
  setApplicationActive,
} from '../../shared/practice/application-state.js';

test('native lifecycle state is shared, deduplicated and listeners can be removed', (t) => {
  setApplicationActive(true);
  const seen: boolean[] = [];
  const remove = onApplicationStateChange((value) => seen.push(value));
  t.after(() => {
    remove();
    setApplicationActive(true);
  });
  setApplicationActive(false);
  setApplicationActive(false);
  assert.equal(isApplicationActive(), false);
  setApplicationActive(true);
  remove();
  setApplicationActive(false);
  assert.deepEqual(seen, [false, true]);
});
test('a delayed initial foreground query cannot override a newer native pause', async (t) => {
  setApplicationActive(true);
  t.after(() => setApplicationActive(true));
  let listener!: (state: { isActive: boolean }) => void,
    complete!: (value: { isActive: boolean }) => void;
  const pending = new Promise<{ isActive: boolean }>((resolve) => {
    complete = resolve;
  });
  let removed = 0;
  const connecting = connectApplicationState({
    async addListener(_event, callback) {
      listener = callback;
      return {
        async remove() {
          removed++;
        },
      };
    },
    getState() {
      return pending;
    },
  });
  listener({ isActive: false });
  complete({ isActive: true });
  const dispose = await connecting;
  assert.equal(isApplicationActive(), false);
  listener({ isActive: true });
  assert.equal(isApplicationActive(), true);
  await dispose();
  listener({ isActive: false });
  assert.equal(isApplicationActive(), true);
  assert.equal(removed, 1);
});
test('an unavailable initial query does not discard subsequent native lifecycle notifications', async (t) => {
  setApplicationActive(true);
  t.after(() => setApplicationActive(true));
  let listener!: (state: { isActive: boolean }) => void;
  const dispose = await connectApplicationState({
    async addListener(_event, callback) {
      listener = callback;
      return { async remove() {} };
    },
    async getState() {
      throw Error('temporarily unavailable');
    },
  });
  listener({ isActive: false });
  assert.equal(isApplicationActive(), false);
  listener({ isActive: true });
  assert.equal(isApplicationActive(), true);
  await dispose();
});
