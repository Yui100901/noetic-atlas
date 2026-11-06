import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImportDedupPreview } from '../../shared/models/import-dedup';
import {
  bulkImportDecision,
  selectImportDecision,
  unresolvedImportItems,
  validImportDecisions,
} from '../../web/shared/lib/import-review-state';

const preview: ImportDedupPreview = {
  fingerprint: 'a'.repeat(64),
  total: 4,
  counts: { new: 1, exact: 1, similar: 2 },
  metrics: { indexed: 30000, compared: 8, candidateLimit: 50 },
  items: [
    { key: 'i-0', index: 0, title: '新增', type: 'short_answer', kind: 'new', candidates: [] },
    {
      key: 'i-1',
      index: 1,
      title: '重复',
      type: 'short_answer',
      kind: 'exact',
      targetId: 'q-1',
      candidates: [],
    },
    ...[2, 3].map((index) => ({
      key: `i-${index}`,
      index,
      title: `候选${index}`,
      type: 'short_answer' as const,
      kind: 'similar' as const,
      candidates: [
        {
          id: `q-${index}`,
          title: '已有题',
          type: 'short_answer' as const,
          status: 'published' as const,
          score: 90,
          reason: '题干相近',
        },
      ],
    })),
  ],
};

test('only similar items require explicit decisions and stale target IDs cannot enable import', () => {
  assert.equal(unresolvedImportItems(preview, []).length, 2);
  assert.deepEqual(
    validImportDecisions(preview, [
      { key: 'i-0', action: 'both' },
      { key: 'i-2', action: 'replace', targetId: 'deleted' },
    ]),
    [],
  );
  assert.equal(unresolvedImportItems(preview, [{ key: 'i-2', action: 'both' }]).length, 1);
});

test('bulk keep/both resolves pending items only and preserves an explicit replacement', () => {
  const chosen = [{ key: 'i-2', action: 'replace' as const, targetId: 'q-2' }];
  assert.deepEqual(bulkImportDecision(preview, chosen, 'both'), [
    ...chosen,
    { key: 'i-3', action: 'both' },
  ]);
  assert.deepEqual(bulkImportDecision(preview, [], 'keep', ['i-2']), [
    { key: 'i-2', action: 'keep', targetId: 'q-2' },
  ]);
  assert.equal(
    unresolvedImportItems(preview, bulkImportDecision(preview, chosen, 'both')).length,
    0,
  );
});

test('changing a target can clear an earlier decision and replacement requires an actual candidate', () => {
  const item = preview.items[2]!;
  const chosen = selectImportDecision([], item, 'replace', 'q-2');
  assert.equal(chosen.length, 1);
  assert.deepEqual(selectImportDecision(chosen, item, null), []);
  assert.deepEqual(selectImportDecision([], item, 'replace', 'not-a-candidate'), []);
  assert.deepEqual(selectImportDecision(chosen, item, 'both'), [{ key: 'i-2', action: 'both' }]);
});
