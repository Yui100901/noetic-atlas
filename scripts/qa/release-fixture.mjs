/** Shared acceptance fixtures. Only invoke against disposable smoke databases. */
import assert from 'node:assert/strict';

export function assertCleanBaseConfiguration(configuration) {
  assert.equal(configuration.format, 'noetic-atlas-configuration');
  assert.equal(configuration.schemaVersion, 1);
  assert.deepEqual(Object.keys(configuration).sort(), ['ai', 'exportedAt', 'format', 'schemaVersion', 'system']);
  assert.equal(configuration.system.examDurationMinutes, 120);
  assert.equal(configuration.system.maxDraftsPerPaper, 3);
  assert.equal(configuration.ai.enabled, false);
  assert.equal(configuration.ai.baseUrl, '');
  assert.equal(configuration.ai.model, '');
  assert.ok(!Object.hasOwn(configuration.ai, 'key') && !Object.hasOwn(configuration.ai, 'token'), 'Base configuration must not carry credentials');
}

export async function assertEmptyInstallation(api, configuration) {
  assertCleanBaseConfiguration(configuration);
  const bootstrap = await api('/api/bootstrap');
  for (const name of ['totalQuestions', 'generalQuestions', 'personalQuestions', 'totalPapers', 'totalDocuments', 'favoriteCount', 'dueCount', 'wrongCount']) assert.equal(bootstrap.stats[name], 0, `Fresh ${name} must be zero`);
  for (const name of ['domains', 'categories', 'tags']) assert.deepEqual(bootstrap[name], [], `Fresh ${name} must be empty`);
  assert.deepEqual(bootstrap.stats.typeCounts, {});
  assert.equal((await api('/api/questions?status=all&page=1&pageSize=10')).total, 0, 'No hidden pending, draft or archived questions may ship');
  const exported = await api('/api/export');
  for (const name of ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'questionBanks', 'study', 'reviews', 'attempts', 'assets', 'paperDrafts']) assert.deepEqual(exported[name], [], `Fresh ${name} must not contain user or question data`);
  assert.equal(exported.settings.length, 1, 'Exactly one basic system configuration is expected');
  const { id, updatedAt, ...system } = await api('/api/settings');
  assert.equal(id, 'system');
  assert.ok(updatedAt);
  assert.deepEqual(system, configuration.system, 'Runtime defaults must match the shipped portable base configuration');
  const { hasKey, updatedAt: _aiStamp, ...ai } = await api('/api/ai/settings');
  assert.equal(hasKey, false);
  assert.deepEqual(ai, configuration.ai, 'Fresh AI settings must be clean defaults');
  const portable = await api('/api/settings/export');
  assert.deepEqual(portable.system, configuration.system);
  assert.deepEqual(portable.ai, configuration.ai);
  return bootstrap;
}

export async function createReviewedReleaseQuestion(api) {
  const domain = await api('/api/domains', 'POST', { id: 'release-smoke-domain', name: '发布验收临时领域' });
  const category = await api('/api/categories', 'POST', { id: 'release-smoke-category', domainId: domain.id, name: '发布验收临时分类' });
  const tag = await api('/api/tags', 'POST', { id: 'release-smoke-tag', domainId: domain.id, name: '发布验收临时标签', kind: 'topic' });
  const question = await api('/api/questions', 'POST', {
    id: 'release-smoke-question', title: '发布验收临时题', type: 'single_choice',
    stemMarkdown: '此题由发布验收流程在隔离临时数据库中新增。请选择 A。',
    options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], correctAnswers: ['A'],
    answerMarkdown: 'A', explanationMarkdown: '验证发布后的新增、审核和计分流程。',
    categoryIds: [category.id], tagIds: [tag.id], status: 'published',
  });
  assert.equal(question.status, 'pending', 'Ordinary additions must not bypass review');
  assert.equal((await api('/api/questions?page=1&pageSize=10')).total, 0, 'A pending question must not enter the public study list');
  const review = await api('/api/questions/review', 'POST', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } });
  assert.equal(review.count, 1);
  assert.equal(review.items[0].status, 'published');
  assert.equal((await api('/api/questions?page=1&pageSize=10')).total, 1);
  return review.items[0];
}

export async function completeReleasePaper(api, question) {
  const paper = await api('/api/papers', 'POST', {
    title: '发布验收临时练习卷', mode: 'manual', questionIds: [question.id],
    scoring: { enabled: true, totalPoints: 2, questionPoints: { [question.id]: 2 } },
  });
  const attempt = await api(`/api/papers/${encodeURIComponent(paper.id)}/attempts`, 'POST', { mode: 'practice' });
  const completed = await api(`/api/attempts/${encodeURIComponent(attempt.id)}/submit`, 'POST', { answers: { [question.id]: { value: 'A' } } });
  assert.equal(completed.status, 'submitted');
  assert.equal(completed.objectiveScore, 2);
  assert.equal(completed.totalScore, 2);
  assert.equal(completed.answerStates[question.id], 'correct');
  assert.ok(Number.isInteger(completed.elapsedSeconds) && completed.elapsedSeconds >= 0);
  return { paper, attempt, completed };
}
