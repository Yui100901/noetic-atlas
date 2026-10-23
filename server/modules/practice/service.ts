import { randomInt } from 'node:crypto';
import type { Attempt, AttemptAnswer, ExamQuestion, Paper, PaperFilters, Question, ScoringInput } from '../../../shared/models/types.js';
import { Store, makeId, now, nextStamp } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { normalizeScoring, planScoredQuestions, cents, fromCents } from './scoring.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { distributeGroupPoints, flattenQuestions, validatePaperAnswers, type StoredLeafQuestion } from '../questions/structure.js';
import { applyAttemptRetention, getSettings } from '../settings/routes.js';
import { validateAssetReferences } from '../assets/routes.js';
import { answerState, attemptElapsedSeconds, examExpired } from '../../../shared/practice/attempt-timing.js';

export interface StoredPaper extends Paper { snapshot: Question[] }
export interface StoredAttempt extends Omit<Attempt, 'questions'> { questions: StoredLeafQuestion[] }
export function examQuestion(q: StoredLeafQuestion, points?: number): ExamQuestion {
  return { id: q.id, sourceQuestionId: q.sourceQuestionId || q.id, title: q.title, type: q.type, stemMarkdown: q.stemMarkdown, options: q.options, difficulty: q.difficulty, depth: q.depth, frequency: q.frequency, collection: q.collection, points, blanks: q.blanks?.map(({ answers: _answers, ...b }) => b), groupId: q.groupId, groupTitle: q.groupTitle, groupStemMarkdown: q.groupStemMarkdown, partId: q.partId, partIndex: q.partIndex };
}
export function expandPaper(p: StoredPaper) {
  validatePaperAnswers(p.snapshot);
  const parentScoring = normalizeScoring(p.snapshot, p.scoring);
  const questions = flattenQuestions(p.snapshot);
  const questionPoints = Object.assign({}, ...p.snapshot.map(q => distributeGroupPoints(q, parentScoring.questionPoints[q.id]!)));
  const scoring = p.snapshot.some(q => q.type === 'group') ? normalizeScoring(questions, { enabled: parentScoring.enabled, totalPoints: parentScoring.totalPoints, questionPoints, objectivePercent: parentScoring.objectivePercent, pointsByType: parentScoring.pointsByType }) : parentScoring;
  return { questions, scoring };
}
export function paperView(p: StoredPaper, detail = false) {
  const { snapshot, ...paper } = p;
  const scoring = normalizeScoring(snapshot, p.scoring);
  const organization = paper.organization || 'other', domainId = organization === 'domain' ? paper.domainId || null : null;
  if (!detail) return { ...paper, organization, domainId, scoring };
  const expanded = expandPaper(p);
  return { ...paper, organization, domainId, scoring, answerCount: expanded.questions.length, questions: expanded.questions.map(q => examQuestion(q, expanded.scoring.questionPoints[q.id])) };
}
export function attemptView(a: StoredAttempt): Attempt {
  const scoring = normalizeScoring(a.questions, a.scoring);
  const subjective = a.questions.filter(q => isSubjectiveType(q.type));
  const gradedSubjectiveCount = scoring.enabled ? subjective.filter(q => a.answers[q.id]?.selfScore != null).length : 0;
  const pendingSubjectiveCount = scoring.enabled ? subjective.length - gradedSubjectiveCount : 0;
  const gradingStatus = !scoring.enabled ? 'not_applicable' : !pendingSubjectiveCount && a.status === 'submitted' ? 'complete' : gradedSubjectiveCount ? 'partial' : 'pending';
  const totalScore = scoring.enabled && a.status === 'submitted' && !pendingSubjectiveCount ? fromCents(cents(a.objectiveScore) + cents(a.subjectiveScore)) : null;
  return { ...a, elapsedSeconds: attemptElapsedSeconds(a), answerStates: Object.fromEntries(a.questions.map(q => [q.id, answerState(q, a.answers[q.id], a.status === 'submitted', scoring.enabled ? scoring.questionPoints[q.id] : undefined)])), source: a.source || 'paper', updatedAt: a.updatedAt || a.startedAt, scoring, gradedSubjectiveCount, pendingSubjectiveCount, gradingStatus, totalScore, questions: a.questions.map(q => a.status === 'submitted' || (a.source === 'quick' && a.referenceViewedAt) ? { ...examQuestion(q, scoring.questionPoints[q.id]), blanks: q.blanks, answerMarkdown: q.answerMarkdown, explanationMarkdown: q.explanationMarkdown, correctAnswers: q.correctAnswers, sourceRefs: q.sourceRefs } : examQuestion(q, scoring.questionPoints[q.id])) };
}
export function buildPaper(store: Store, input: { id?: string; title: string; description: string; mode: 'manual' | 'random'; organization?: 'domain' | 'other'; domainId?: string | null; questionIds?: string[]; filters?: PaperFilters | null; count?: number; scoring?: ScoringInput }, previous?: StoredPaper): StoredPaper {
  if (input.id === QUICK_PAPER_ID) fail(400, 'RESERVED_PAPER_ID', '随机单题标识不能用作试卷ID');
  const organization = input.organization || 'other', domainId = organization === 'domain' ? input.domainId || null : null;
  if (organization === 'domain' && !domainId) fail(400, 'PAPER_DOMAIN_REQUIRED', '领域专项练习卷必须选择所属领域');
  if (domainId) store.require('domains', domainId);
  const settings = getSettings(store);
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
    const pool = store.questions(input.filters || {});
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
  const snapshot = selected.map(q => { const { study: _study, ...clean } = q; return clean; });
  validatePaperAnswers(snapshot);
  const scoring = normalizeScoring(snapshot, scoringInput);
  return { id: previous?.id || input.id || makeId('paper'), title: input.title, description: input.description, mode: input.mode, organization, domainId, questionIds: snapshot.map(q => q.id), questionCount: snapshot.length, filters: input.mode === 'random' ? input.filters || {} : null, scoring, archived: false, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt || now(), updatedAt: now(), snapshot };
}
export function createAttempt(store: Store, paper: StoredPaper, options: { mode?: 'practice' | 'exam'; durationMinutes?: number } = {}): StoredAttempt {
  const practiceMode = options.mode || 'practice';
  if (practiceMode === 'exam') {
    syncExams(store);
    const active = getActiveExam(store);
    if (active) fail(409, 'ACTIVE_EXAM_EXISTS', '请先完成进行中的考试', { attemptId: active.id });
  }
  const durationMinutes = practiceMode === 'exam' ? options.durationMinutes ?? (getSettings(store) as any).examDurationMinutes ?? 120 : null;
  if (durationMinutes != null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) fail(400, 'INVALID_EXAM_DURATION', '考试时长需为 1–1440 分钟的整数');
  const { questions, scoring } = expandPaper(paper), stamp = draftStamp(store, 'paper', paper.id), startedAt = now();
  const a: StoredAttempt = { practiceMode, durationMinutes, deadlineAt: durationMinutes == null ? null : new Date(Date.parse(startedAt) + durationMinutes * 60000).toISOString(), elapsedSeconds: 0, autoSubmitted: false, id: makeId('attempt'), source: 'paper', paperId: paper.id, paperTitle: paper.title, paperVersion: paper.version, status: 'in_progress', questions: structuredClone(questions), scoring: structuredClone(scoring), answers: {}, objectiveScore: 0, objectiveMax: scoring.objectivePoints, subjectiveScore: 0, subjectiveMax: scoring.subjectivePoints, startedAt, updatedAt: stamp, submittedAt: null };
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
  const stamps = store.all<StoredAttempt>('attempts').filter(a => (a.source || 'paper') === source && a.paperId === paperId).map(a => a.updatedAt || a.startedAt).sort();
  return nextStamp(stamps.at(-1));
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
    if (answer.selfScore != null || answer.mastery != null) fail(400, 'EARLY_SELF_SCORE', '判分和掌握自评仅在交卷后通过复盘接口提交');
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
    if (!q || (!isSubjectiveType(q.type) && answer.selfScore != null) || (attempt.status === 'in_progress' && (answer.selfScore != null || answer.mastery != null)) || (answer.selfScore != null && (!scoring.enabled || answer.selfScore < 0 || cents(answer.selfScore) > cents(scoring.questionPoints[qid]!)))) fail(400, 'INVALID_ATTEMPT', '评分或掌握自评与题型、满分或作答状态不一致');
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
  store.transaction(() => {
    attempt.status = 'submitted'; attempt.submittedAt = expired ? attempt.deadlineAt! : draftStamp(store, attempt.source || 'paper', attempt.paperId); attempt.updatedAt = nextStamp(attempt.updatedAt);  attempt.objectiveScore = 0;
    const wrongSources = new Set<string>();
    for (const q of attempt.questions) {
      if (isSubjectiveType(q.type)) continue;
      if (isCorrect(q, attempt.answers[q.id])) attempt.objectiveScore = fromCents(cents(attempt.objectiveScore) + cents(scoring.questionPoints[q.id]!));
      else if (store.get('questions', q.sourceQuestionId || q.id) && !wrongSources.has(q.sourceQuestionId || q.id)) {
        const sourceId = q.sourceQuestionId || q.id; wrongSources.add(sourceId);
        const state = store.study(sourceId); state.wrongCount += 1;
        state.nextReviewAt = now(); store.put('study', sourceId, state);
      }
    }
    store.put('attempts', attempt.id, attempt);
    applyAttemptRetention(store, attempt);
  }); return attempt;
}
export function reviewAttempt(store: Store, attempt: StoredAttempt, scores: Record<string, number | null> = {}, mastery: Record<string, number> = {}) {
  if (attempt.status !== 'submitted') fail(409, 'NOT_SUBMITTED', '请先交卷，再进行主观题自评');
  const scoring = normalizeScoring(attempt.questions, attempt.scoring); attempt.scoring = scoring;
  store.transaction(() => {
    for (const [id, score] of Object.entries(scores)) {
      const q = attempt.questions.find(q => q.id === id);
      if (!q || !isSubjectiveType(q.type)) fail(400, 'INVALID_SELF_SCORE', '只能自评本次练习中的主观题');
      if (!scoring.enabled) fail(400, 'SCORING_DISABLED', '本卷不计分，请提交0至3的掌握自评');
      if (score != null && (score < 0 || cents(score) > cents(scoring.questionPoints[id]!))) fail(400, 'SCORE_EXCEEDS_MAX', '主观题分数不可超过该题满分', { questionId: id, max: scoring.questionPoints[id] });
      const old = attempt.answers[id];
      attempt.answers[id] = { ...old, value: old?.value || '', selfScore: score };
      if (score != null && mastery[id] === undefined) mastery[id] = scoring.questionPoints[id]! > 0 ? Math.round(score / scoring.questionPoints[id]! * 3) : 3;
    }
    const reviewedSources = new Set<string>();
    for (const [id, level] of Object.entries(mastery)) {
      if (!attempt.questions.some(q => q.id === id)) fail(400, 'INVALID_MASTERY_QUESTION', '掌握自评题号不属于本次练习');
      const old = attempt.answers[id]; attempt.answers[id] = { ...old, value: old?.value || '', mastery: level };
    }
    for (const id of Object.keys(mastery)) {
      const q = attempt.questions.find(q => q.id === id)!, sourceId = q.sourceQuestionId || id;
      if (!store.get('questions', sourceId) || reviewedSources.has(sourceId)) continue;
      reviewedSources.add(sourceId);
      const sourceLevels = attempt.questions.filter(q => (q.sourceQuestionId || q.id) === sourceId).map(q => attempt.answers[q.id]?.mastery).filter((v): v is number => v != null);
      const aggregate = Math.min(...sourceLevels);
      const state = store.study(sourceId); state.mastery = aggregate; state.lastReviewedAt = now();
      state.nextReviewAt = new Date(Date.now() + getSettings(store).reviewIntervalsDays[aggregate]! * 86400000).toISOString();
      store.put('study', sourceId, state);
      const reviewId = makeId('review');
      store.put('reviews', reviewId, { id: reviewId, questionId: sourceId, mastery: aggregate, reviewedAt: now(), source: 'attempt', attemptId: attempt.id });
    }
    attempt.subjectiveScore = fromCents(Object.values(attempt.answers).reduce((n, a) => n + cents(a.selfScore ?? 0), 0));
    attempt.updatedAt = nextStamp(attempt.updatedAt || attempt.startedAt); store.put('attempts', attempt.id, attempt);
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
