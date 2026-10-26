import { randomInt } from 'node:crypto';
import type { AnswerVerdict, Attempt, AttemptAnswer, ExamQuestion, Paper, PaperFilters, PaperPracticeKind, Question, ScoringInput, VocabularyDirection } from '../../../shared/models/types.js';
import { Store, makeId, now, nextStamp } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { normalizeScoring, planScoredQuestions, cents, fromCents } from './scoring.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { distributeGroupPoints, flattenQuestions, validatePaperAnswers, type StoredLeafQuestion } from '../questions/structure.js';
import { applyAttemptRetention, getSettings } from '../settings/routes.js';
import { validateAssetReferences } from '../assets/routes.js';
import { answerState, attemptElapsedSeconds, examExpired, isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { isVocabularyQuestion, resolveVocabularyQuestion, reverseVocabularyQuestion, validateVocabularyPaperSnapshot } from './vocabulary-practice.js';
import { preserveLearningResults } from './learning-results.js';
import type { ReviewRating } from '../../../shared/models/adaptive-review.js';
import { syncAttemptReviewEvents } from '../review-scheduler/service.js';

export interface StoredPaper extends Paper { snapshot: Question[] }
export interface StoredAttempt extends Omit<Attempt, 'questions'> { questions: StoredLeafQuestion[] }
export function examQuestion(q: StoredLeafQuestion, points?: number): ExamQuestion {
  return { id: q.id, sourceQuestionId: q.sourceQuestionId || q.id, title: q.title, type: q.type, stemMarkdown: q.stemMarkdown, options: q.options, difficulty: q.difficulty, depth: q.depth, frequency: q.frequency, collection: q.collection, points, blanks: q.blanks?.map(({ answers: _answers, ...b }) => b), groupId: q.groupId, groupTitle: q.groupTitle, groupStemMarkdown: q.groupStemMarkdown, partId: q.partId, partIndex: q.partIndex };
}
export function expandPaper(p: StoredPaper, maxAnswers = 1_500_000) {
  validatePaperAnswers(p.snapshot, maxAnswers);
  const parentScoring = normalizeScoring(p.snapshot, p.scoring);
  const questions = flattenQuestions(p.snapshot);
  const questionPoints:Record<string,number> = {};
  for(const question of p.snapshot) Object.assign(questionPoints,distributeGroupPoints(question,parentScoring.questionPoints[question.id]!));
  const scoring = p.snapshot.some(q => q.type === 'group') ? normalizeScoring(questions, { enabled: parentScoring.enabled, totalPoints: parentScoring.totalPoints, questionPoints, objectivePercent: parentScoring.objectivePercent, pointsByType: parentScoring.pointsByType }) : parentScoring;
  return { questions, scoring };
}
export function paperView(p: StoredPaper, detail: boolean | 'summary' = false) {
  const { snapshot, ...paper } = p;
  const scoring = normalizeScoring(snapshot, p.scoring);
  const organization = paper.organization || 'other', domainId = organization === 'domain' ? paper.domainId || null : null;
  const practiceKind = paper.practiceKind || 'standard';
  if (!detail) return { ...paper, practiceKind, organization, domainId, scoring };
  const expanded = expandPaper(p);
  return { ...paper, practiceKind, organization, domainId, scoring, answerCount: expanded.questions.length, questions: expanded.questions.map(q => {const view=examQuestion(q, expanded.scoring.questionPoints[q.id]);return detail==='summary'?{...view,stemMarkdown:'',options:[],blanks:undefined,groupStemMarkdown:undefined}:view;}) };
}
export function attemptView(a: StoredAttempt): Attempt {
  const scoring = normalizeScoring(a.questions, a.scoring);
  const subjective = a.questions.filter(q => isSubjectiveType(q.type));
  const gradedSubjectiveCount = scoring.enabled ? subjective.filter(q => a.answers[q.id]?.selfScore != null).length : 0;
  const pendingSubjectiveCount = scoring.enabled ? subjective.length - gradedSubjectiveCount : 0;
  const gradingStatus = !scoring.enabled ? 'not_applicable' : !pendingSubjectiveCount && a.status === 'submitted' ? 'complete' : gradedSubjectiveCount ? 'partial' : 'pending';
  const totalScore = scoring.enabled && a.status === 'submitted' && !pendingSubjectiveCount ? fromCents(cents(a.objectiveScore) + cents(a.subjectiveScore)) : null;
  return { ...a, elapsedSeconds: attemptElapsedSeconds(a), answerStates: Object.fromEntries(a.questions.map(q => [q.id, answerState(q, a.answers[q.id], a.status === 'submitted', scoring.enabled ? scoring.questionPoints[q.id] : undefined)])), source: a.source || 'paper', updatedAt: a.updatedAt || a.startedAt, scoring, gradedSubjectiveCount, pendingSubjectiveCount, gradingStatus, totalScore, questions: a.questions.map(q => a.status === 'submitted' || (a.source === 'quick' && a.referenceViewedAt) ? { ...examQuestion(q, scoring.questionPoints[q.id]), blanks: q.blanks, answerMarkdown: q.answerMarkdown, explanationMarkdown: q.explanationMarkdown, correctAnswers: q.correctAnswers, sourceRefs: q.sourceRefs, vocabulary: q.vocabulary } : examQuestion(q, scoring.questionPoints[q.id])) };
}
export function buildPaper(store: Store, input: { id?: string; title: string; description: string; mode: 'manual' | 'random'; practiceKind?: PaperPracticeKind; organization?: 'domain' | 'other'; domainId?: string | null; questionIds?: string[]; filters?: PaperFilters | null; count?: number; scoring?: ScoringInput }, previous?: StoredPaper): StoredPaper {
  if (input.id === QUICK_PAPER_ID) fail(400, 'RESERVED_PAPER_ID', '随机单题标识不能用作试卷ID');
  const organization = input.organization || 'other', domainId = organization === 'domain' ? input.domainId || null : null;
  if (organization === 'domain' && !domainId) fail(400, 'PAPER_DOMAIN_REQUIRED', '领域专项题集必须选择所属领域');
  if (domainId) store.require('domains', domainId);
  const settings = getSettings(store);
  const practiceKind = input.practiceKind || 'standard';
  // Persist resolved defaults in every newly created snapshot. Subsequent
  // configuration changes do not recalculate a saved paper or old attempt.
  const scoringInput = input.scoring ? { ...input.scoring, objectivePercent: input.scoring.objectivePercent ?? settings.objectivePercent, pointsByType: { ...settings.pointsByType, ...input.scoring.pointsByType }, ...(input.mode === 'random' && input.scoring.enabled && input.scoring.totalPoints === undefined ? { totalPoints: settings.randomTotalPoints } : {}) } : { enabled: settings.scoringEnabledByDefault, objectivePercent: settings.objectivePercent, pointsByType: settings.pointsByType, ...(input.mode === 'random' && settings.scoringEnabledByDefault ? { totalPoints: settings.randomTotalPoints } : {}) };
  const count = input.count ?? (input.mode === 'random' && !scoringInput.enabled ? settings.randomQuestionCount : undefined);
  let selected: Question[];
  if (input.mode === 'manual') {
    if (!input.questionIds?.length) fail(400, 'EMPTY_PAPER', '至少选择一道题目');
    selected = input.questionIds!.map(id => {
      const q = store.require<Question>('questions', id);
      if (q.status !== 'published') fail(400, 'QUESTION_UNAVAILABLE', `题目尚未发布或已归档：${id}`);
      return q;
    });
  } else {
    const pool = store.questions(input.filters || {}).filter(question => practiceKind !== 'vocabulary' || isVocabularyQuestion(question));
    // Unbiased Fisher–Yates; each eligible question is sampled at most once.
    for (let i = pool.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
    if (scoringInput.enabled) {
      const plan = planScoredQuestions(pool, scoringInput, count);
      selected = [];
      if (plan.questionIds) selected = plan.questionIds.map(id => pool.find(q => q.id === id)!);
      else for (const type of Object.keys(plan.selected) as Question['type'][]) selected.push(...pool.filter(q => q.type === type).slice(0, plan.selected[type]));
      for (let i = selected.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [selected[i], selected[j]] = [selected[j]!, selected[i]!]; }
    } else {
      if (pool.length < count!) fail(422, 'INSUFFICIENT_QUESTIONS', '满足筛选条件的题目不足，未放宽筛选条件', { available: pool.length, requested: count });
      selected = pool.slice(0, count);
    }
  }
  const snapshot = selected.map(q => { const { study: _study, partStudies: _parts, ...clean } = practiceKind === 'vocabulary' ? resolveVocabularyQuestion(store, q) : q; return clean; });
  if (practiceKind === 'vocabulary') validateVocabularyPaperSnapshot(snapshot);
  validatePaperAnswers(snapshot,input.mode==='manual'?1_500_000:500);
  const scoring = normalizeScoring(snapshot, scoringInput);
  return { ...(previous?.legacyBankId ? {legacyBankId:previous.legacyBankId}:{}), id: previous?.id || input.id || makeId('paper'), title: input.title, description: input.description, mode: input.mode, practiceKind, organization, domainId, questionIds: snapshot.map(q => q.id), questionCount: snapshot.length, filters: input.mode === 'random' ? input.filters || {} : null, scoring, archived: false, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt || now(), updatedAt: now(), snapshot };
}
export function createAttempt(store: Store, paper: StoredPaper, options: { mode?: 'practice' | 'exam'; durationMinutes?: number; count?: number; selection?: 'ordered' | 'random'; vocabularyDirection?: VocabularyDirection } = {}): StoredAttempt {
  if (options.vocabularyDirection && paper.practiceKind !== 'vocabulary') fail(400, 'VOCABULARY_PAPER_REQUIRED', '请先将题集类型设置为词汇题集，再选择词汇练习方向');
  const vocabularyDirection = paper.practiceKind === 'vocabulary' ? options.vocabularyDirection || 'word_to_meaning' : undefined;
  const practiceMode = options.mode || 'practice';
  if (practiceMode === 'exam') {
    syncExams(store);
    const active = getActiveExam(store);
    if (active) fail(409, 'ACTIVE_EXAM_EXISTS', '请先完成进行中的考试', { attemptId: active.id });
  }
  const durationMinutes = practiceMode === 'exam' ? options.durationMinutes ?? (getSettings(store) as any).examDurationMinutes ?? 120 : null;
  if (durationMinutes != null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) fail(400, 'INVALID_EXAM_DURATION', '考试时长需为 1–1440 分钟的整数');
  const allCount = flattenQuestions(paper.snapshot).length;
  if (!paper.snapshot.length) fail(400, 'EMPTY_PAPER', '题集尚无题目，请先添加题目');
  if (options.count === undefined && allCount > 500) fail(422, 'QUESTION_SET_SESSION_LIMIT', '大型题集请先选择本次练习题量，每次最多500个作答项', { available: allCount, limit: 500 });
  if (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 1 || options.count > 500 || options.count > paper.snapshot.length)) fail(400, 'INVALID_SESSION_COUNT', '本次题量须为1至500且不超过题集题数的整数');
  let sessionPaper = paper;
  if (options.count !== undefined) {
    const pool = [...paper.snapshot];
    if (options.selection === 'random') for (let i=pool.length-1;i>0;i--) { const j=randomInt(0,i+1); [pool[i],pool[j]]=[pool[j]!,pool[i]!]; }
    const snapshot = pool.slice(0, options.count);
    validatePaperAnswers(snapshot);
    const original = normalizeScoring(paper.snapshot, paper.scoring);
    const scoring = normalizeScoring(snapshot, { enabled: original.enabled, questionPoints: Object.fromEntries(snapshot.map(q=>[q.id,original.questionPoints[q.id]!])), objectivePercent: original.objectivePercent, pointsByType: original.pointsByType });
    sessionPaper = {...paper, snapshot, questionIds:snapshot.map(q=>q.id), questionCount:snapshot.length, scoring};
  }
  if (vocabularyDirection) {
    const snapshot = sessionPaper.snapshot.map(question => resolveVocabularyQuestion(store, question));
    const directed = vocabularyDirection === 'meaning_to_word' ? snapshot.map(reverseVocabularyQuestion) : snapshot;
    const originalScoring = normalizeScoring(sessionPaper.snapshot, sessionPaper.scoring);
    const scoring = normalizeScoring(directed, { enabled: originalScoring.enabled, totalPoints: originalScoring.enabled ? originalScoring.totalPoints : undefined, questionPoints: originalScoring.questionPoints, objectivePercent: originalScoring.objectivePercent, pointsByType: originalScoring.pointsByType });
    sessionPaper = { ...sessionPaper, snapshot: directed, scoring };
  }
  const { questions, scoring } = expandPaper(sessionPaper, 500), stamp = draftStamp(store, 'paper', paper.id), startedAt = now();
  const a: StoredAttempt = { ...(vocabularyDirection ? { vocabularyDirection } : {}), practiceMode, durationMinutes, deadlineAt: durationMinutes == null ? null : new Date(Date.parse(startedAt) + durationMinutes * 60000).toISOString(), elapsedSeconds: 0, autoSubmitted: false, id: makeId('attempt'), source: 'paper', paperId: paper.id, paperTitle: paper.title, paperVersion: paper.version, status: 'in_progress', questions: structuredClone(questions), scoring: structuredClone(scoring), answers: {}, objectiveScore: 0, objectiveMax: scoring.objectivePoints, subjectiveScore: 0, subjectiveMax: scoring.subjectivePoints, startedAt, updatedAt: stamp, submittedAt: null };
  store.transaction(() => { store.insert('attempts', a.id, a); trimDrafts(store, a); }); return a;
}
/** Explicit POST synchronization is important for offline storage: successful writes
 * are flushed as one transaction by the Android runtime. Read-only APIs never mutate. */
export function syncAttempt(store: Store, attempt: StoredAttempt): StoredAttempt {
  return examExpired(attempt) ? submitAttempt(store, attempt) : attempt;
}
function activeExamQuery(store: Store) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  return db.query.selectFrom('attempts').where(field('data','practiceMode'),'=','exam').where(field('data','status'),'=','in_progress').orderBy(field('data','startedAt'),'asc').limit(1);
}
/** API guards need only the session ID, never the potentially large snapshot. */
export function getActiveExamId(store: Store): string | undefined {
  return store.database.one(activeExamQuery(store).select('id'))?.id;
}
export function getActiveExam(store: Store): StoredAttempt | undefined {
  const row=store.database.one(activeExamQuery(store).select('data'));
  return row?JSON.parse(row.data):undefined;
}
export function syncExams(store: Store): void {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const rows=db.all(db.query.selectFrom('attempts').select('data').where(field('data','practiceMode'),'=','exam').where(field('data','status'),'=','in_progress'));
  for(const row of rows){const attempt=JSON.parse(row.data) as StoredAttempt;if(examExpired(attempt))submitAttempt(store,attempt);}
}
export function validateAttemptTiming(attempt: StoredAttempt): void {
  const bad = () => fail(400, 'INVALID_ATTEMPT_TIMING', '作答计时、考试期限或自动交卷标记不一致');
  if (attempt.elapsedSeconds != null && (!Number.isInteger(attempt.elapsedSeconds) || attempt.elapsedSeconds < 0)) bad();
  if (attempt.practiceMode === 'exam') {
    if (attempt.source === 'quick' || !Number.isInteger(attempt.durationMinutes) || attempt.durationMinutes! < 1 || attempt.durationMinutes! > 1440 || !attempt.deadlineAt || Date.parse(attempt.deadlineAt) - Date.parse(attempt.startedAt) !== attempt.durationMinutes! * 60000) bad();
    if (attempt.autoSubmitted && (attempt.status !== 'submitted' || attempt.submittedAt !== attempt.deadlineAt)) bad();
    if (attempt.status === 'submitted' && attempt.submittedAt && Date.parse(attempt.submittedAt) > Date.parse(attempt.deadlineAt!)) bad();
    if (attempt.elapsedSeconds != null && attempt.elapsedSeconds > attempt.durationMinutes! * 60) bad();
  } else if (attempt.durationMinutes != null || attempt.deadlineAt != null || attempt.autoSubmitted) bad();
}
export const QUICK_PAPER_ID = 'quick-practice';
function draftStamp(store: Store, source: 'paper' | 'quick', paperId: string) {
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  let query = db.query.selectFrom('attempts').select([field<string | null>('data', 'updatedAt').as('updatedAt'), field<string>('data', 'startedAt').as('startedAt')]).where(field('data', 'paperId'), '=', paperId);
  query = source === 'quick' ? query.where(field('data', 'source'), '=', 'quick') : query.where(eb => eb.or([eb(field('data', 'source'), '=', 'paper'), eb(field('data', 'source'), 'is', null)]));
  const latest = db.one(query.orderBy(eb => eb.fn.coalesce(field<string>('data', 'updatedAt'), field<string>('data', 'startedAt')), 'desc').limit(1));
  return nextStamp(latest?.updatedAt || latest?.startedAt);
}
export function createQuickAttempt(store: Store, input: { questionId?: string; excludeQuestionId?: string; filters?: PaperFilters }): StoredAttempt {
  const pool = input.questionId ? [store.require<Question>('questions', input.questionId)] : store.questions(input.filters || {}).filter(q => q.id !== input.excludeQuestionId);
  if (!pool.length) fail(422, 'INSUFFICIENT_QUESTIONS', '当前筛选范围内没有已发布题目');
  const q = pool[randomInt(0, pool.length)]!;
  if (q.status !== 'published') fail(400, 'QUESTION_UNAVAILABLE', '仅已发布题目可以开始单题自测');
  const stamp = draftStamp(store, 'quick', QUICK_PAPER_ID), questions = flattenQuestions([q]).map(({ study: _study, ...clean }) => clean), scoring = normalizeScoring(questions, { enabled: false });
  const a: StoredAttempt = { id: makeId('attempt'), source: 'quick', paperId: QUICK_PAPER_ID, paperTitle: q.title, paperVersion: 1, status: 'in_progress', questions, scoring, answers: {}, objectiveScore: 0, objectiveMax: 0, subjectiveScore: 0, subjectiveMax: 0, startedAt: stamp, updatedAt: stamp, submittedAt: null };
  store.transaction(() => { store.insert('attempts', a.id, a); trimDrafts(store, a); }); return a;
}
export function trimDrafts(store: Store, attempt: StoredAttempt) {
  applyAttemptRetention(store, attempt);
}
export function saveAttempt(store: Store, attempt: StoredAttempt, answers: Record<string, AttemptAnswer>) {
  if (examExpired(attempt)) return submitAttempt(store, attempt);
  if (attempt.status === 'submitted') fail(409, 'ALREADY_SUBMITTED', '已交卷，不能更改作答');
  validateAssetReferences(store, answers, getSettings(store));
  mergeAnswers(attempt, answers); attempt.elapsedSeconds = attemptElapsedSeconds(attempt); attempt.updatedAt = draftStamp(store, attempt.source || 'paper', attempt.paperId);
  store.transaction(() => { store.put('attempts', attempt.id, attempt); trimDrafts(store, attempt); }); return attempt;
}
export function revealQuickAttempt(store: Store, attempt: StoredAttempt) {
  if (attempt.source !== 'quick') fail(409, 'PAPER_REFERENCE_HIDDEN', '试卷交卷前不能查看参考答案');
  if (!attempt.referenceViewedAt) { attempt.referenceViewedAt = now(); attempt.updatedAt = nextStamp(attempt.updatedAt || attempt.startedAt); store.put('attempts', attempt.id, attempt); }
  return attempt;
}
export function mergeAnswers(attempt: StoredAttempt, answers: Record<string, AttemptAnswer>) {
  for (const [id, answer] of Object.entries(answers)) {
    const q = attempt.questions.find(q => q.id === id);
    if (!q) fail(400, 'INVALID_ANSWER_QUESTION', `作答题目不属于本次练习：${id}`);
    if (answer.selfScore != null || answer.mastery != null || answer.verdict != null) fail(400, 'EARLY_SELF_SCORE', '判分和掌握自评仅在交卷后通过复盘接口提交');
    if (isSubjectiveType(q!.type)) {
      if (typeof answer.value !== 'string') fail(400, 'INVALID_ANSWER', '主观题答案须为文本');
    } else if (q!.type === 'fill_blank') {
      if (!Array.isArray(answer.value) || answer.value.length !== q!.blanks?.length) fail(400, 'INVALID_ANSWER', '填空题答案须为与空位顺序对应的文本数组');
    } else {
      const values = Array.isArray(answer.value) ? answer.value : answer.value ? [answer.value] : [];
      const allowed = q!.type === 'true_false' ? ['true', 'false'] : q!.options.map(o => o.key);
      if (new Set(values).size !== values.length || values.some(v => !allowed.includes(v)) || (q!.type !== 'multiple_choice' && values.length > 1)) fail(400, 'INVALID_ANSWER', '选项无效、重复或单选题选择了多项');
    }
    attempt.answers[id] = { value: answer.value };
  }
}
export function isCorrect(q: Question, answer?: AttemptAnswer) {
  return getObjectiveCorrect(q, answer);
}
export function validateAttemptSnapshot(attempt: StoredAttempt) {
  validateAttemptTiming(attempt);
  if (attempt.vocabularyDirection) {
    if (attempt.source === 'quick' && (attempt.vocabularyDirection !== 'meaning_to_word' || attempt.questions.length !== 1 || attempt.paperTitle !== '看释义想单词')) fail(400, 'INVALID_VOCABULARY_ATTEMPT', '旧词汇单题历史的来源与快照不一致');
    if (attempt.vocabularyDirection === 'word_to_meaning') validateVocabularyPaperSnapshot(attempt.questions);
    else for (const q of attempt.questions) {
      if (!q.vocabulary || q.type !== 'fill_blank' || q.title !== '看释义想单词' || q.groupId || q.partId) fail(400, 'INVALID_VOCABULARY_ATTEMPT', '词汇逆向练习的来源与快照不一致');
      const expected = reverseVocabularyQuestion(q);
      if (q.stemMarkdown !== expected.stemMarkdown || JSON.stringify(q.blanks) !== JSON.stringify(expected.blanks) || q.options.length || q.correctAnswers.length || q.parts) fail(400, 'INVALID_VOCABULARY_ATTEMPT', '词汇逆向练习的提示或可接受词形不一致');
    }
  }
  const groups = new Map<string, StoredLeafQuestion[]>();
  for (const q of attempt.questions) {
    if (q.type === 'group') fail(400, 'INVALID_ATTEMPT_PARTS', '作答快照必须展平组合题的每个子题');
    const hasGroup = q.groupId !== undefined || q.partId !== undefined || q.sourceQuestionId !== undefined || q.groupTitle !== undefined || q.groupStemMarkdown !== undefined || q.partIndex !== undefined;
    if (hasGroup && (!q.groupId || !q.partId || q.sourceQuestionId !== q.groupId || q.id !== `${q.groupId}::${q.partId}` || q.groupStemMarkdown === undefined || q.groupTitle === undefined || q.partIndex === undefined)) fail(400, 'INVALID_ATTEMPT_PARTS', '子题的来源题号、顺序和公共材料元数据不完整或不一致');
    if (q.groupId) { const parts = groups.get(q.groupId) || []; parts.push(q); groups.set(q.groupId, parts); }
  }
  for (const parts of groups.values()) {
    if (parts.length < 2 || parts.length > 30 || parts.some((part, index) => part.partIndex !== index || part.groupTitle !== parts[0]!.groupTitle || part.groupStemMarkdown !== parts[0]!.groupStemMarkdown)) fail(400, 'INVALID_ATTEMPT_PARTS', '组合题子题必须完整、有序，且共用相同的公共材料');
  }
  const scoring = normalizeScoring(attempt.questions, attempt.scoring);
  const expectedObjectiveMax = scoring.objectivePoints;
  const expectedSubjectiveMax = scoring.subjectivePoints;
  const validationCopy = { ...attempt, answers: {} } as StoredAttempt;
  const plainAnswers: Record<string, AttemptAnswer> = {};
  for (const [qid, answer] of Object.entries(attempt.answers)) {
    plainAnswers[qid] = { value: answer.value };
    const q = attempt.questions.find(q => q.id === qid);
    if (!q || (!isSubjectiveType(q.type) && (answer.selfScore != null || answer.verdict != null)) || (attempt.status === 'in_progress' && (answer.selfScore != null || answer.mastery != null || answer.verdict != null)) || (answer.selfScore != null && (!scoring.enabled || answer.selfScore < 0 || cents(answer.selfScore) > cents(scoring.questionPoints[qid]!)))) fail(400, 'INVALID_ATTEMPT', '评分或掌握自评与题型、满分或作答状态不一致');
    if(answer.verdict!=null&&scoring.enabled&&answer.selfScore!=null&&answer.verdict!==(answer.selfScore>=scoring.questionPoints[qid]!? 'correct':answer.selfScore>0?'partial':'incorrect'))fail(400,'INVALID_ATTEMPT','主观判定与保存分值不一致');
  }
  mergeAnswers(validationCopy, plainAnswers);
  const expectedObjectiveScore = attempt.status === 'submitted' ? fromCents(attempt.questions.reduce((n, q) => n + (!isSubjectiveType(q.type) && isCorrect(q, attempt.answers[q.id]) ? cents(scoring.questionPoints[q.id]!) : 0), 0)) : 0;
  const expectedSubjectiveScore = fromCents(Object.values(attempt.answers).reduce((n, a) => n + cents(a.selfScore ?? 0), 0));
  if (cents(attempt.objectiveMax) !== cents(expectedObjectiveMax) || cents(attempt.subjectiveMax) !== cents(expectedSubjectiveMax) || cents(attempt.objectiveScore) !== cents(expectedObjectiveScore) || cents(attempt.subjectiveScore) !== cents(expectedSubjectiveScore)) fail(400, 'INVALID_ATTEMPT_SCORE', '导入成绩与题目快照及作答不一致，未导入任何数据');
}
export function submitAttempt(store: Store, attempt: StoredAttempt, answers?: Record<string, AttemptAnswer>) {
  if (attempt.status === 'submitted') return attempt;
  const expired = examExpired(attempt);
  // Once the persisted deadline has passed, late requests cannot replace saved answers.
  if (!expired && answers) validateAssetReferences(store, answers, getSettings(store));
  if (!expired && answers) mergeAnswers(attempt, answers);
  attempt.autoSubmitted = expired;
  attempt.elapsedSeconds = attemptElapsedSeconds(attempt);
  const scoring = normalizeScoring(attempt.questions, attempt.scoring);
  attempt.scoring = scoring;
  const settings = getSettings(store);
  store.transaction(() => {
    attempt.status = 'submitted'; attempt.submittedAt = expired ? attempt.deadlineAt! : draftStamp(store, attempt.source || 'paper', attempt.paperId); attempt.updatedAt = nextStamp(attempt.updatedAt);  attempt.objectiveScore = 0;
    const wrongSources = new Set<string>();
    for (const q of attempt.questions) {
      if (isSubjectiveType(q.type)) continue;
      if (isCorrect(q, attempt.answers[q.id])) attempt.objectiveScore = fromCents(cents(attempt.objectiveScore) + cents(scoring.questionPoints[q.id]!));
      else {
        const sourceId = q.sourceQuestionId || q.id, source = store.get<Question>('questions', sourceId), key = JSON.stringify([sourceId, q.partId]);
        if (!source || wrongSources.has(key) || (q.partId !== undefined ? source.type !== 'group' || !source.parts?.some(part => part.id === q.partId && part.type === q.type) : source.type === 'group')) continue;
        wrongSources.add(key);
        const state = store.study(sourceId, q.partId); state.wrongCount += 1;
        // Fixed scheduling keeps its legacy immediate wrong-answer queue.
        // FSRS owns its due date, including when automatic rating is disabled.
        if (settings.reviewScheduling.strategy === 'fixed') state.nextReviewAt = now();
        store.putStudy(state);
      }
    }
    store.put('attempts', attempt.id, attempt);
    syncAttemptReviewEvents(store, attempt);
    preserveLearningResults(store, attempt);
    applyAttemptRetention(store, attempt);
  }); return attempt;
}
export function reviewAttempt(store: Store, attempt: StoredAttempt, scores: Record<string, number | null> = {}, mastery: Record<string, number> = {}, verdicts:Record<string,AnswerVerdict|null> = {}, ratings: Record<string, ReviewRating | null> = {}) {
  if (attempt.status !== 'submitted') fail(409, 'NOT_SUBMITTED', '请先交卷，再进行主观题自评');
  const scoring = normalizeScoring(attempt.questions, attempt.scoring); attempt.scoring = scoring;
  const settings = getSettings(store);
  const learningWasReset = !!store.get<{ reset?: boolean }>('learning_results', attempt.id)?.reset;
  for (const id of Object.keys(ratings)) {
    if (!attempt.questions.some(question => question.id === id)) fail(400, 'INVALID_REVIEW_QUESTION', '回忆评级题号不属于本次练习');
    if (!isAnswerPresent(attempt.answers[id])) fail(400, 'REVIEW_ANSWER_REQUIRED', '只有实际填写并提交的回答可以评价回忆质量');
  }
  if (Object.keys(ratings).length && settings.reviewScheduling.strategy !== 'fsrs') fail(409, 'FSRS_DISABLED', '当前使用固定复习间隔，请先开启自适应复习再评价回忆质量');
  store.transaction(() => {
    for (const [id, score] of Object.entries(scores)) {
      const q = attempt.questions.find(q => q.id === id);
      if (!q || !isSubjectiveType(q.type)) fail(400, 'INVALID_SELF_SCORE', '只能自评本次练习中的主观题');
      if (!scoring.enabled) fail(400, 'SCORING_DISABLED', '本卷不计分，请提交0至3的掌握自评');
      if (score != null && (score < 0 || cents(score) > cents(scoring.questionPoints[id]!))) fail(400, 'SCORE_EXCEEDS_MAX', '主观题分数不可超过该题满分', { questionId: id, max: scoring.questionPoints[id] });
      const old = attempt.answers[id];
      attempt.answers[id] = { ...old, value: old?.value || '', selfScore: score, verdict:score==null?null:score>=scoring.questionPoints[id]!? 'correct':score>0?'partial':'incorrect' };
      if (score != null && mastery[id] === undefined) mastery[id] = scoring.questionPoints[id]! > 0 ? Math.round(score / scoring.questionPoints[id]! * 3) : 3;
    }
    for(const [id,verdict] of Object.entries(verdicts)){
      const q=attempt.questions.find(q=>q.id===id);if(!q||!isSubjectiveType(q.type))fail(400,'INVALID_VERDICT','只能判定本次作答中的主观题');
      const old=attempt.answers[id],score=old?.selfScore;
      if(scoring.enabled&&score!=null&&verdict!==(score>=scoring.questionPoints[id]!? 'correct':score>0?'partial':'incorrect'))fail(400,'VERDICT_SCORE_MISMATCH','判题结果与数字分值不一致，请同时更新或撤销评分');
      attempt.answers[id]={...old,value:old?.value||'',verdict};
      if(verdict!=null&&mastery[id]===undefined)mastery[id]=verdict==='correct'?3:verdict==='partial'?2:0;
    }
    const changedMastery = new Set<string>();
    for (const [id, level] of Object.entries(mastery)) {
      if (!attempt.questions.some(q => q.id === id)) fail(400, 'INVALID_MASTERY_QUESTION', '掌握自评题号不属于本次练习');
      const old = attempt.answers[id]; if (old?.mastery !== level) changedMastery.add(id);
      attempt.answers[id] = { ...old, value: old?.value || '', mastery: level };
    }
    for (const id of changedMastery) {
      // A later score correction edits the retained historical sheet only;
      // explicit progress reset must not be undone by its old auto-self-rating.
      if (learningWasReset) continue;
      const q = attempt.questions.find(q => q.id === id)!, sourceId = q.sourceQuestionId || id;
      const source = store.get<Question>('questions', sourceId);
      if (!source || (q.partId !== undefined ? source.type !== 'group' || !source.parts?.some(part => part.id === q.partId && part.type === q.type) : source.type === 'group')) continue;
      const level = mastery[id]!;
      const state = store.study(sourceId, q.partId); state.mastery = level;
      if (settings.reviewScheduling.strategy === 'fixed') {
        state.lastReviewedAt = now();
        state.nextReviewAt = new Date(Date.now() + settings.reviewIntervalsDays[level]! * 86400000).toISOString();
      }
      store.putStudy(state);
      const reviewId = makeId('review');
      store.put('reviews', reviewId, { id: reviewId, questionId: sourceId, ...(q.partId === undefined ? {} : { partId: q.partId }), mastery: level, reviewedAt: now(), source: 'attempt', attemptId: attempt.id });
    }
    attempt.subjectiveScore = fromCents(Object.values(attempt.answers).reduce((n, a) => n + cents(a.selfScore ?? 0), 0));
    attempt.updatedAt = nextStamp(attempt.updatedAt || attempt.startedAt); store.put('attempts', attempt.id, attempt);
    const reviewedLeaves = [...new Set([...Object.keys(scores), ...Object.keys(verdicts), ...Object.keys(ratings)])];
    if (reviewedLeaves.length) syncAttemptReviewEvents(store, attempt, ratings, reviewedLeaves);
    preserveLearningResults(store, attempt);
  }); return attempt;
}
export function paperMarkdown(paper: StoredPaper, answers: boolean): string {
  const { questions, scoring } = expandPaper(paper);
  return [`# ${paper.title}`, '', paper.description, '', `共 ${paper.questionCount} 道题 / ${questions.length} 个作答项；版本 ${paper.version}；${scoring.enabled ? `总分 ${scoring.totalPoints} 分，客观 ${scoring.objectivePoints} 分 / 主观 ${scoring.subjectivePoints} 分` : '本卷不计分'}。`, '', ...questions.flatMap((q, i) => [
    ...(q.groupId && q.partIndex === 0 ? [`## 公共材料：${q.groupTitle}`, '', q.groupStemMarkdown || '', ''] : []),
    `## ${i + 1}. ${q.title}`, '', `题号：${q.id} · D${q.difficulty}/L${q.depth}/F${q.frequency}${scoring.enabled ? ` · ${scoring.questionPoints[q.id]} 分` : ' · 不计分'}`, '', q.stemMarkdown, '', ...q.options.map(o => `- ${o.key}. ${o.text}`), '',
    ...(q.blanks || []).map(b => `${b.label}：${answers ? b.answers.join(' / ') : '________________'}`), '',
    `[定位原题与答案解析](#/questions/${encodeURIComponent(q.sourceQuestionId || q.id)})`, '', ...(answers ? ['### 参考答案', '', q.answerMarkdown || q.correctAnswers.join('、'), '', '### 解析', '', q.explanationMarkdown, ''] : []),
  ])].join('\n');
}
