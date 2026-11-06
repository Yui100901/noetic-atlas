import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, now } from '../../server/core/store.js';
import { parse, questionSchema, paperInputSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import {
  buildPaper,
  createAttempt,
  type StoredPaper,
} from '../../server/modules/practice/service.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/service.js';
import { validateStoredRubrics } from '../../server/modules/practice/grading-requirements.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  return store;
}
function group(id: string, prefix: string, order = [1, 2], changed = false): Question {
  return parse(questionSchema, {
    id,
    title: '事务组合题',
    type: 'group',
    stemMarkdown: '公共材料：事务提交和回滚。',
    status: 'published',
    createdAt: now(),
    updatedAt: now(),
    parts: order.map((number) => ({
      id: prefix + number,
      title: `子题${number}`,
      type: 'short_answer',
      stemMarkdown: `解释事务概念${number}${changed ? '及适用条件' : ''}`,
      answerMarkdown: `整体执行${number}`,
      gradingRequirements: `原始要求${number}`,
      options: [],
      correctAnswers: [],
    })),
  }) as Question;
}
function paper(store: Store, ids: string[], overrides: Record<string, string> = {}) {
  const value = buildPaper(
    store,
    parse(paperInputSchema, {
      title: '组合题判题要求映射',
      mode: 'manual',
      questionIds: ids,
      questionGradingRequirements: overrides,
      scoring: { enabled: false },
    }),
  );
  store.put('papers', value.id, value);
  return value;
}
const bankState = (store: Store) =>
  JSON.stringify(
    ['questions', 'papers', 'study', 'question_revisions'].map((table) => store.all(table as any)),
  );

test('exact group reuse remaps every rubric child ID and preserves local study and a valid frozen snapshot', (t) => {
  const source = fixture(t),
    target = fixture(t);
  source.put('questions', 'source-group', group('source-group', 'source-part'));
  target.put('questions', 'local-group', group('local-group', 'local-part'));
  target.put('study', 'local-group', {
    questionId: 'local-group',
    favorite: true,
    notes: '保留本地笔记',
    mastery: 2,
    nextReviewAt: null,
    lastReviewedAt: null,
    wrongCount: 3,
  });
  const original = paper(source, ['source-group'], {
    'source-group::source-part1': '题集专用要求',
  });
  const pack = exportShare(source, { kind: 'paper', id: original.id });
  assert.equal(planShareImport(target, pack).dedup.counts.exact, 1);
  const study = target.get('study', 'local-group');
  importShare(target, pack);
  assert.equal(target.all('questions').length, 1);
  const imported = target.all<StoredPaper>('papers')[0]!;
  assert.equal(imported.snapshot[0]!.parts![0]!.gradingRequirements, '题集专用要求');
  assert.deepEqual(imported.questionGradingRequirements, {
    'local-group::local-part1': '题集专用要求',
  });
  assert.deepEqual(imported.inheritedGradingRequirements, {
    'local-group::local-part1': '原始要求1',
  });
  assert.equal(imported.snapshot[0]!.parts![1]!.gradingRequirements, '原始要求2');
  assert.deepEqual(target.get('study', 'local-group'), study);
  validateStoredRubrics(imported);
  const attempt = createAttempt(target, imported);
  assert.deepEqual(
    attempt.questions.map((question) => question.id),
    ['local-group::local-part1', 'local-group::local-part2'],
  );
  const restored = fixture(t);
  importData(restored, exportData(target));
  validateStoredRubrics(restored.all<StoredPaper>('papers')[0]!);
});

test('explicit replacement maps reordered source children to their retained local IDs without losing set overrides', (t) => {
  const source = fixture(t),
    target = fixture(t);
  source.put('questions', 'source-group', group('source-group', 'source-part', [2, 1]));
  target.put('questions', 'local-group', group('local-group', 'local-part'));
  const original = paper(source, ['source-group'], {
    'source-group::source-part2': '重排后第一小题标准',
  });
  const pack = exportShare(source, { kind: 'paper', id: original.id });
  const preview = planShareImport(target, pack);
  assert.equal(preview.dedup.counts.similar, 1);
  importShare(target, pack, preview.preview.fingerprint, {
    expectedFingerprint: preview.dedup.fingerprint,
    decisions: [{ key: 'i-0', action: 'replace', targetId: 'local-group' }],
  });
  const imported = target.all<StoredPaper>('papers')[0]!;
  assert.deepEqual(
    target.get<Question>('questions', 'local-group')!.parts!.map((part) => part.id),
    ['local-part2', 'local-part1'],
  );
  assert.deepEqual(imported.questionGradingRequirements, {
    'local-group::local-part2': '重排后第一小题标准',
  });
  assert.equal(imported.snapshot[0]!.parts![0]!.gradingRequirements, '重排后第一小题标准');
  validateStoredRubrics(imported);
});

test('keeping a different group refuses ambiguous rubric mapping atomically while keeping both remains valid', (t) => {
  const source = fixture(t),
    target = fixture(t);
  source.put('questions', 'source-group', group('source-group', 'source-part', [1, 2], true));
  target.put('questions', 'local-group', group('local-group', 'local-part'));
  const original = paper(source, ['source-group'], {
    'source-group::source-part1': '只适用于来源材料的标准',
  });
  const pack = exportShare(source, { kind: 'paper', id: original.id });
  const preview = planShareImport(target, pack),
    before = bankState(target);
  assert.throws(
    () =>
      importShare(target, pack, preview.preview.fingerprint, {
        expectedFingerprint: preview.dedup.fingerprint,
        decisions: [{ key: 'i-0', action: 'keep', targetId: 'local-group' }],
      }),
    (error: any) => error.code === 'IMPORT_GROUP_RUBRIC_MAPPING_REQUIRED',
  );
  assert.equal(bankState(target), before);
  importShare(target, pack, preview.preview.fingerprint, {
    expectedFingerprint: preview.dedup.fingerprint,
    decisions: [{ key: 'i-0', action: 'both' }],
  });
  assert.equal(target.all('questions').length, 2);
  validateStoredRubrics(target.all<StoredPaper>('papers')[0]!);
});

test('collapsing exact duplicate groups cannot silently choose conflicting per-set grading requirements', (t) => {
  const source = fixture(t),
    target = fixture(t);
  source.put('questions', 'source-a', group('source-a', 'part-a'));
  source.put('questions', 'source-b', group('source-b', 'part-b'));
  const original = paper(source, ['source-a', 'source-b'], {
    'source-a::part-a1': '要求甲',
    'source-b::part-b1': '要求乙',
  });
  const pack = exportShare(source, { kind: 'paper', id: original.id });
  const before = bankState(target);
  assert.throws(
    () => importShare(target, pack),
    (error: any) => error.code === 'IMPORT_COLLAPSED_RUBRIC_CONFLICT',
  );
  assert.equal(bankState(target), before);
});
