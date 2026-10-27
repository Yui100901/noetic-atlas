import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { conceptSchema, questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import { conceptPromptIsSafe } from '../../shared/questions/concept.js';
import { attemptView, buildPaper, createAttempt, reviewAttempt, saveAttempt, submitAttempt, validateAttemptSnapshot } from '../../server/modules/practice/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/routes.js';
import { archiveAttemptQuestionHistory } from '../../server/modules/questions/history-store.js';
import { learningMetadata } from '../../server/modules/practice/learning-results.js';
import { questionHistory, questionStatistics } from '../../server/modules/questions/history.js';
import { attemptReviewOverview, changeReviewCard, recordManualReview, reviewCardId, reviewCardView, reviewQueue } from '../../server/modules/review-scheduler/service.js';

const concept = { term: '沉没成本', meaningPrompt: '已经发生且无法收回的支出', acceptedAnswers: ['沉没成本', 'sunk cost'] };
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const first = questionSchema.parse({ id: 'CC-S', title: '沉没成本', type: 'short_answer', stemMarkdown: '解释沉没成本。', answerMarkdown: '已经发生且无法收回的支出。', explanationMarkdown: '沉没成本不应左右只考虑未来增量收益与成本的选择。英文sunk cost。', concept }) as Question;
  const second = questionSchema.parse({ id: 'CC-O', title: '机会成本', type: 'short_answer', stemMarkdown: '解释机会成本。', answerMarkdown: '为获得所选方案而放弃的最佳替代方案价值。', concept: { term: '机会成本', meaningPrompt: '选择一个方案时放弃的最佳替代方案的价值', acceptedAnswers: ['机会成本', 'opportunity cost'] } }) as Question;
  const plain = questionSchema.parse({ id: 'CC-P', title: '通用简答', type: 'short_answer', stemMarkdown: '解释一种现象。', answerMarkdown: '没有独立概念元数据。' }) as Question;
  for (const item of [first, second, plain]) store.put('questions', item.id, item);
  const paper = buildPaper(store, { title: '经济学概念练习', description: '', mode: 'manual', practiceKind: 'concept', questionIds: [first.id, second.id], scoring: { enabled: false } }); store.put('papers', paper.id, paper);
  return { store, first, second, plain, paper };
}
test('concept definitions are independent, answer-free and do not require language pronunciation metadata', () => {
  assert.deepEqual(conceptSchema.parse(concept), concept); assert.equal(conceptPromptIsSafe(concept), true);
  for (const meaningPrompt of ['沉没成本是已无法收回的支出', 'The sunk cost cannot be recovered', '[提示](https://example.org)', '<span>提示</span>']) assert.equal(conceptSchema.safeParse({ ...concept, meaningPrompt }).success, false);
  assert.equal(conceptPromptIsSafe({ term: 'C', acceptedAnswers: ['C'], meaningPrompt: 'A common programming language' }), true);
  assert.equal(conceptSchema.safeParse({ ...concept, acceptedAnswers: ['only other name'] }).success, false);
});
test('concept is a distinct set kind and manual/random authoring excludes ordinary short answers', t => {
  const { store, paper, first, plain } = fixture(t); assert.equal(paper.practiceKind, 'concept');
  assert.throws(() => buildPaper(store, { title: '混合', description: '', mode: 'manual', practiceKind: 'concept', questionIds: [first.id, plain.id] }), /概念/);
  const random = buildPaper(store, { title: '随机概念', description: '', mode: 'random', practiceKind: 'concept', count: 2, scoring: { enabled: false } }); assert.deepEqual(new Set(random.questionIds), new Set(['CC-S', 'CC-O']));
});
test('both concept directions hide the opposite side until submission; reverse grading accepts listed aliases', t => {
  const { store, paper, first, second } = fixture(t), source = JSON.stringify(paper);
  const forward = createAttempt(store, paper); assert.equal(forward.practiceKind, 'concept'); assert.match(forward.questions[0]!.stemMarkdown, /沉没成本/); assert.doesNotMatch(JSON.stringify(attemptView(forward)), /无法收回/);
  const reverse = createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' }), view = attemptView(reverse);
  for (const hidden of ['沉没成本', '机会成本', 'sunk cost', 'opportunity cost']) assert.ok(!JSON.stringify(view).includes(hidden), hidden);
  assert.equal(view.questions[0]!.concept, undefined); validateAttemptSnapshot(reverse);
  saveAttempt(store, reverse, { [first.id]: { value: [' SUNK COST '] } }); const resumed = store.require<typeof reverse>('attempts', reverse.id); assert.equal(resumed.vocabularyDirection, 'meaning_to_word');
  submitAttempt(store, resumed); assert.equal(attemptView(resumed).answerStates?.[first.id], 'correct'); assert.equal(questionStatistics(store, first.id).correct, 1); assert.equal(questionStatistics(store, second.id).answered, 0);
  assert.equal(JSON.stringify(paper), source); assert.equal(store.require<Question>('questions', first.id).type, 'short_answer');
});
test('concept directions create separate adaptive review identities and retain concept labels after history pruning', t => {
  const { store, paper, first } = fixture(t);
  const reverse = submitAttempt(store, createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' }), { [first.id]: { value: ['沉没成本'] } });
  const r = attemptReviewOverview(store, reverse); assert.equal(r.items.find(item => item.leafId === first.id)?.direction, 'meaning_to_word'); assert.equal(r.items.find(item => item.leafId === first.id)?.rating, 'good');
  const forward = submitAttempt(store, createAttempt(store, paper), { [first.id]: { value: '不可收回的历史支出' } }); reviewAttempt(store, forward, undefined, undefined, { [first.id]: 'correct' });
  const f = attemptReviewOverview(store, forward); assert.equal(f.items.find(item => item.leafId === first.id)?.direction, 'word_to_meaning');
  const cards = store.database.records<any>('review_cards').filter(card => card.questionId === first.id); assert.equal(cards.length, 2);
  archiveAttemptQuestionHistory(store, reverse); store.remove('attempts', reverse.id); const saved = learningMetadata(store).find(item => item.id === reverse.id); assert.equal(saved?.practiceKind, 'concept'); assert.equal(saved?.vocabularyDirection, 'meaning_to_word');
  const history = questionHistory(store, first.id, {page:1,pageSize:10}); assert.equal(history.items.find(item => item.attemptId === reverse.id)?.question.concept?.term, '沉没成本');
});
test('concept source, sets, submitted reverse snapshots and metadata survive sharing and complete migration', t => {
  const { store, paper, first } = fixture(t); submitAttempt(store, createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' }), { [first.id]: { value: ['沉没成本'] } });
  const copy = new Store(':memory:'); t.after(() => copy.db.close()); importData(copy, exportData(store)); assert.deepEqual(copy.require<Question>('questions', first.id).concept, concept); assert.equal(copy.all<any>('attempts')[0].practiceKind, 'concept');
  const receiver = new Store(':memory:'); t.after(() => receiver.db.close()); const shared = exportShare(store, { kind: 'paper', id: paper.id }), plan = planShareImport(receiver, shared); importShare(receiver, shared);
  const imported = receiver.all<any>('papers')[0]; assert.equal(imported.practiceKind, 'concept'); assert.deepEqual(imported.snapshot[0].concept, concept);
});
test('tampered reverse prompts or answer aliases fail validation instead of exposing the concept', t => {
  const { store, paper } = fixture(t), reverse = createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' });
  reverse.questions[0]!.stemMarkdown += '沉没成本'; assert.throws(() => validateAttemptSnapshot(reverse), /概念/);
});

test('adding concept metadata preserves existing standard memory and reads it as the same forward alias without writes', t => {
  const { store, first } = fixture(t), at = new Date('2026-10-26T08:00:00.000Z');
  store.put('questions', first.id, { ...first, concept: undefined });
  const old = recordManualReview(store, { questionId: first.id, direction: 'standard', rating: 'good', requestId: 'concept-legacy-original' }, new Date(at.getTime()-86400000));
  changeReviewCard(store, { questionId: first.id, direction: 'standard', dueAt: new Date(at.getTime()-1000).toISOString() }, at);
  const rows = () => Object.fromEntries((['review_cards','review_events','reviews'] as const).map(table=>[table,store.database.all(store.database.query.selectFrom(table).select(['id','data']).orderBy('id'))]));
  const before = rows(), oldCard = reviewCardView(store, {questionId:first.id,direction:'standard'},at).card!;
  store.put('questions', first.id, first);
  const forward = reviewCardView(store, {questionId:first.id,direction:'word_to_meaning'},at);
  assert.equal(forward.card?.id, old.card?.id); assert.deepEqual(forward.card?.memory, oldCard.memory);
  assert.equal(forward.direction,'standard'); assert.equal(forward.eventCount,1);
  const queue = reviewQueue(store,{page:1,pageSize:20,direction:'word_to_meaning'},at);
  const queued = queue.items.filter(item=>item.questionId===first.id); assert.equal(queued.length,1);assert.equal(queued[0]!.direction,'standard');assert.equal(queued[0]!.logicalDirection,'word_to_meaning');
  assert.deepEqual(rows(),before,'metadata enrichment and GETs must not modify old review rows');
  const reviewed=recordManualReview(store,{questionId:first.id,direction:queued[0]!.direction,rating:'good',requestId:'concept-legacy-next'},at);
  assert.equal(reviewed.card?.id,old.card?.id);assert.equal(reviewed.card?.memory.reps,2);assert.equal(reviewed.eventCount,2);
  assert.equal(store.get('review_cards',reviewCardId({questionId:first.id,direction:'word_to_meaning'})),undefined);
  assert.equal(reviewQueue(store,{page:1,pageSize:20},at).items.filter(item=>item.questionId===first.id).length,0);
  recordManualReview(store,{questionId:first.id,direction:'word_to_meaning',rating:'good',requestId:'concept-legacy-next'},at);
  assert.equal(store.database.records('review_events').length,2,'forward alias retries must remain idempotent');
});

test('concept forward attempts reuse the legacy standard card while reverse remains independent across full migration', t => {
  const { store, first, paper }=fixture(t),at=new Date('2026-10-25T08:00:00.000Z');
  store.put('questions',first.id,{...first,concept:undefined});
  const old=recordManualReview(store,{questionId:first.id,direction:'standard',rating:'good',requestId:'old-concept-card'},at);
  store.put('questions',first.id,first);
  const forward=submitAttempt(store,createAttempt(store,paper),{[first.id]:{value:'已经发生、无法收回的支出'}});reviewAttempt(store,forward,undefined,undefined,{[first.id]:'correct'});
  const overview=attemptReviewOverview(store,forward).items.find(item=>item.questionId===first.id)!;assert.equal(overview.direction,'standard');assert.equal(overview.card?.id,old.card?.id);assert.equal(overview.card?.memory.reps,2);
  const reverse=submitAttempt(store,createAttempt(store,paper,{vocabularyDirection:'meaning_to_word'}),{[first.id]:{value:['沉没成本']}});
  assert.equal(attemptReviewOverview(store,reverse).items.find(item=>item.questionId===first.id)?.direction,'meaning_to_word');
  const copy=new Store(':memory:');t.after(()=>copy.db.close());importData(copy,exportData(store));
  assert.equal(reviewCardView(copy,{questionId:first.id,direction:'word_to_meaning'}).card?.memory.reps,2);
  assert.equal(reviewCardView(copy,{questionId:first.id,direction:'meaning_to_word'}).card?.memory.reps,1);
  assert.equal(copy.database.records<any>('review_cards').filter(card=>card.questionId===first.id).length,2);
});
