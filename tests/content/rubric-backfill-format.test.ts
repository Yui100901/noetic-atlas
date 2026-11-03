import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import {
  applyRubricBackfill,
  planRubricBackfill,
  recordTableDigest,
} from '../../scripts/content/backfill-rubrics.js';

test('bad rubric formatting introduced after planning rolls back the whole batch', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  for (const id of ['A', 'B'])
    store.put(
      'questions',
      id,
      questionSchema.parse({
        id,
        title: id,
        type: 'short_answer',
        stemMarkdown: '解释提交和回滚。',
        answerMarkdown: '全部提交，或在失败时回滚全部操作。',
      }),
    );
  const plan = planRubricBackfill(store.database);
  assert.equal(plan.formatIssueCount, 0);
  assert.equal(plan.changes.length, 2);
  const before = recordTableDigest(store.database, 'questions');
  plan.changes[1]!.question.gradingRequirements = '1. -\n2. ...';
  assert.throws(() => applyRubricBackfill(store.database, plan), /format errors/);
  assert.equal(recordTableDigest(store.database, 'questions'), before);
});

test('a changed rubric plan cannot replace the validated generated standard', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  store.put(
    'questions',
    'A',
    questionSchema.parse({
      id: 'A',
      title: '解释提交',
      type: 'short_answer',
      stemMarkdown: '解释提交。',
      answerMarkdown: '提交使事务结果生效。',
    }),
  );
  const plan = planRubricBackfill(store.database),
    before = recordTableDigest(store.database, 'questions');
  plan.changes[0]!.question.gradingRequirements = '无论写什么都算正确。';
  assert.throws(() => applyRubricBackfill(store.database, plan), /changed after planning/);
  assert.equal(recordTableDigest(store.database, 'questions'), before);
});
