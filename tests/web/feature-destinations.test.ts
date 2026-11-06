import assert from 'node:assert/strict';
import test from 'node:test';
import { relocatedAiHref } from '../../web/shared/lib/feature-destinations.js';

test('relocated AI bookmarks retain run and document context in their owning feature', () => {
  assert.equal(relocatedAiHref('tab=history&run=run-1'), '#/analytics?run=run-1&tab=ai&mode=all');
  assert.equal(relocatedAiHref('tab=documents&job=job-1'), '#/sharing?job=job-1&tab=documents');
  assert.equal(relocatedAiHref('tab=import'), '#/sharing?tab=import');
  assert.equal(relocatedAiHref(''), '#/papers/new/ai');
  assert.equal(relocatedAiHref('tab=https://evil.invalid'), '#/papers/new/ai');
});
