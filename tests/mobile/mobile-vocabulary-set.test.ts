import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

/** Uses the production Android runtime and SQLite WASM; only durable file
 * storage is replaced with private test bytes. No workspace DB is opened. */
test('mobile vocabulary sets retain direction, answer drafts and grading through WASM restarts', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const seed = { schemaVersion: 1, domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] };
  let durable: Uint8Array | undefined;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { durable = bytes.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage); t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', data?: unknown, status = 200): Promise<any> => {
    const response = await runtime.fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  const words = [{
    id: 'MOBILE-WORD-EN', title: 'abandon', type: 'short_answer', stemMarkdown: '**abandon**', answerMarkdown: '放弃；遗弃', explanationMarkdown: '常用于放弃计划或遗弃某物。', status: 'published',
    vocabulary: { language: 'en', headword: 'abandon', meaningPrompt: '放弃；遗弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '美式', ipa: '/əˈbændən/', sourceLabel: 'Test source', sourceUrl: 'https://example.org/readings', license: 'MIT', method: 'source' }] },
  }, {
    id: 'MOBILE-WORD-JA', title: '学校｜日语单词', type: 'short_answer', stemMarkdown: '**学校**', answerMarkdown: '供学生学习的机构', explanationMarkdown: '日语名词。', status: 'published',
    vocabulary: { language: 'ja', headword: '学校', meaningPrompt: '供学生学习的机构', acceptedAnswers: ['学校', 'がっこう'], pronunciations: [{ label: '假名与罗马音', kana: 'がっこう', romaji: 'gakkou', sourceLabel: 'Test source', sourceUrl: 'https://example.org/readings', license: 'CC-BY-SA-4.0', method: 'transliteration' }] },
  }];
  await api('/api/import', 'POST', { mode: 'merge', data: { ...seed, questions: words } });
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 2);
  const paper = await api('/api/papers', 'POST', { title: '移动端高频词汇练习', mode: 'manual', practiceKind: 'vocabulary', questionIds: words.map(word => word.id), scoring: { enabled: true, totalPoints: 5, questionPoints: { 'MOBILE-WORD-EN': 2, 'MOBILE-WORD-JA': 3 } } }, 201);
  assert.equal(paper.practiceKind, 'vocabulary');
  await api('/api/quick-practice', 'POST', { questionId: words[0].id, direction: 'meaning_to_word' }, 400);
  await api('/api/quick-practice', 'POST', { questionId: words[0].id, vocabularyDirection: 'meaning_to_word' }, 400);

  const reverse = await api(`/api/papers/${paper.id}/attempts`, 'POST', { vocabularyDirection: 'meaning_to_word' }, 201);
  assert.equal(reverse.vocabularyDirection, 'meaning_to_word');
  assert.equal(reverse.objectiveMax, 5); assert.equal(reverse.subjectiveMax, 0);
  assert.equal(reverse.questions.length, 2);
  assert.ok(reverse.questions.every((question: any) => question.type === 'fill_blank' && !question.vocabulary && !question.answerMarkdown && !question.blanks[0].answers));
  for (const answer of ['abandon', 'əˈbændən', '学校', 'がっこう', 'gakkou']) assert.equal(JSON.stringify(reverse.questions).includes(answer), false, 'reverse response leaked ' + answer);
  await api(`/api/attempts/${reverse.id}`, 'PUT', { answers: { 'MOBILE-WORD-EN': { value: ['Abandon'] } } });
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);

  assert.equal((await api(`/api/papers/${paper.id}`)).practiceKind, 'vocabulary');
  const reopened = await api(`/api/attempts/${reverse.id}`);
  assert.equal(reopened.status, 'in_progress'); assert.equal(reopened.vocabularyDirection, 'meaning_to_word');
  assert.deepEqual(reopened.answers['MOBILE-WORD-EN'].value, ['Abandon']);
  const drafts = await api(`/api/papers/${paper.id}/drafts`);
  assert.equal(drafts.length, 1); assert.equal(drafts[0].id, reverse.id); assert.equal(drafts[0].vocabularyDirection, 'meaning_to_word');
  const graded = await api(`/api/attempts/${reverse.id}/submit`, 'POST', { answers: { 'MOBILE-WORD-JA': { value: ['がっこう'] } } });
  assert.equal(graded.objectiveScore, 5); assert.equal(graded.totalScore, 5);
  assert.deepEqual(graded.answerStates, { 'MOBILE-WORD-EN': 'correct', 'MOBILE-WORD-JA': 'correct' });
  assert.equal((await api(`/api/questions/${words[0].id}/statistics`)).correct, 1);
  assert.equal((await api(`/api/questions/${words[1].id}/statistics`)).correct, 1);

  const forward = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  assert.equal(forward.vocabularyDirection, 'word_to_meaning');
  assert.ok(forward.questions.every((question: any) => question.type === 'short_answer'));
  assert.equal(forward.objectiveMax, 0); assert.equal(forward.subjectiveMax, 5);
  const submitted = await api(`/api/attempts/${forward.id}/submit`, 'POST', { answers: { 'MOBILE-WORD-EN': { value: '放弃；遗弃' }, 'MOBILE-WORD-JA': { value: '供学生学习的机构' } } });
  assert.equal(submitted.pendingSubjectiveCount, 2); assert.equal(submitted.totalScore, null);
  const reviewed = await api(`/api/attempts/${forward.id}/review`, 'PUT', { scores: { 'MOBILE-WORD-EN': 2, 'MOBILE-WORD-JA': 3 } });
  assert.equal(reviewed.totalScore, 5);
  const share = await api('/api/sharing/export', 'POST', { kind: 'paper', id: paper.id });
  assert.equal(share.papers[0].practiceKind, 'vocabulary');
  assert.ok(share.papers[0].snapshot.every((question: any) => question.vocabulary));
  assert.equal((await api('/api/sharing/preview', 'POST', { data: share })).counts.papers.reused, 1);
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
  assert.equal((await api(`/api/attempts/${reverse.id}`)).vocabularyDirection, 'meaning_to_word');
  assert.equal((await api(`/api/attempts/${forward.id}`)).vocabularyDirection, 'word_to_meaning');
  assert.equal((await api(`/api/attempts/${reverse.id}`)).totalScore, 5);
  assert.equal((await api(`/api/questions/${words[0].id}/history`)).items.find((item: any) => item.attemptId === reverse.id).vocabularyDirection, 'meaning_to_word');
  assert.deepEqual((await api(`/api/papers/${paper.id}/drafts`)), []);
});
