import { recordPlanEvidence } from '../learning-plans/progress.js';
import { createHash, randomInt } from 'node:crypto';
import type { z } from 'zod';
import type { Question, AttemptAnswer, StudyState } from '../../../shared/models/types.js';
import type {
  FocusItem,
  FocusSession,
  FocusSummary,
  FocusView,
} from '../../../shared/models/focus-review.js';
import type { ReviewDirection } from '../../../shared/models/adaptive-review.js';
import { Store, makeId, nextStamp, now } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { flattenQuestions } from '../questions/structure.js';
import {
  examQuestion,
  submitAttempt,
  reviewAttempt,
  QUICK_PAPER_ID,
  type StoredAttempt,
  type StoredPaper,
} from '../practice/service.js';
import { normalizeScoring } from '../practice/scoring.js';
import { initialPracticeTiming, freezePracticeTiming } from '../practice/practice-timing.js';
import { reverseVocabularyQuestion } from '../practice/vocabulary-practice.js';
import { reverseConceptQuestion } from '../practice/concept-practice.js';
import { recordManualReview, reviewQueue, reviewCardId } from '../review-scheduler/service.js';
import { getSettings } from '../settings/service.js';
import { validateAssetReferences } from '../assets/service.js';
import { focusRetentionCandidates } from './retention.js';
import { studyPartKey } from '../../../shared/questions/study-state.js';
import { createFocusSchema, focusActionSchema, focusSessionSchema } from './schema.js';

/** Key order can change during JSON migration without changing question content. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const fingerprint = ({ createdAt: _created, updatedAt: _updated, ...question }: Question) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(question)))
    .digest('hex');
export const focusSummary = (session: FocusSession): FocusSummary => ({
  id: session.id,
  paperId: session.paperId,
  ...(session.learningDayId ? { learningDayId: session.learningDayId } : {}),
  ...(session.learningGoalId ? { learningGoalId: session.learningGoalId } : {}),
  title: session.title,
  status: session.status,
  scope: session.scope,
  total: session.items.length,
  rated: session.items.filter((item) => item.phase === 'rated').length,
  skipped: session.items.filter((item) => item.phase === 'skipped').length,
  written: session.items.filter((item) => !!item.attemptId).length,
  mental: session.items.filter((item) => item.phase === 'rated' && item.mode === 'mental').length,
  ratings: {
    again: session.items.filter((item) => item.rating === 'again').length,
    hard: session.items.filter((item) => item.rating === 'hard').length,
    good: session.items.filter((item) => item.rating === 'good').length,
    easy: session.items.filter((item) => item.rating === 'easy').length,
  },
  elapsedSeconds: session.elapsedSeconds,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
  submittedAt: session.submittedAt,
});
export function saveFocus(store: Store, session: FocusSession) {
  session.summary = focusSummary(session);
  store.put('focus_sessions', session.id, session);
  if (session.status === 'submitted')
    for (const row of focusRetentionCandidates(store, getSettings(store), {
      paperId: session.paperId,
      learningDayId: session.learningDayId || null,
      status: 'submitted',
      preserveId: session.id,
    }))
      store.remove('focus_sessions', row.id);
}
export function validateFocusSession(value: unknown): FocusSession {
  const session = parse(focusSessionSchema, value) as FocusSession;
  if (
    session.items
      .slice(0, session.index)
      .some((item) => !['rated', 'skipped'].includes(item.phase)) ||
    (session.status === 'in_progress' && session.index === session.items.length)
  )
    fail(400, 'FOCUS_PROGRESS_INVALID', '复习会话进度不一致');
  session.summary = focusSummary(session);
  return session;
}
export function focusView(session: FocusSession): FocusView {
  const current = session.status === 'in_progress' ? session.items[session.index] : undefined;
  return {
    ...focusSummary(session),
    revision: session.revision,
    strategy: session.strategy,
    practiceTiming: session.practiceTiming,
    ...(session.reset ? { reset: true } : {}),
    current: current
      ? {
          index: session.index,
          key: current.key,
          direction: current.direction,
          question: examQuestion(current.question),
          phase: current.phase,
          mode: current.mode,
          ...(current.answer ? { answer: current.answer } : {}),
          ...(current.phase === 'revealed'
            ? {
                reference: current.question,
                ...(!isSubjectiveType(current.question.type) && current.mode === 'written'
                  ? { correct: getObjectiveCorrect(current.question, current.answer) }
                  : {}),
                ...(current.attemptId ? { attemptId: current.attemptId } : {}),
              }
            : {}),
        }
      : null,
    results: session.items.flatMap((item, index) =>
      ['rated', 'skipped'].includes(item.phase)
        ? [
            {
              index,
              title: item.question.title,
              ...(item.beforeReset ? { beforeReset: true as const } : {}),
              phase: item.phase,
              rating: item.rating,
              dueAt: item.dueAt,
              attemptId: item.attemptId,
            },
          ]
        : [],
    ),
  };
}
export interface FocusIdentity {
  questionId: string;
  partId?: string;
  direction: ReviewDirection;
  paperId?: string;
  paperTitle?: string;
  paperVersion?: number;
}
export function createFocusItems(
  store: Store,
  identities: FocusIdentity[],
  stamp = now(),
): FocusItem[] {
  return identities.map((identity) => {
    const original = store.require<Question>('questions', identity.questionId);
    const { study: _study, partStudies: _parts, feedbackSummary: _feedback, ...clean } = original;
    const directed =
      identity.direction === 'meaning_to_word'
        ? original.concept
          ? reverseConceptQuestion(clean)
          : reverseVocabularyQuestion(clean)
        : clean;
    const leaf =
      flattenQuestions([directed]).find((q) => q.partId === identity.partId) ||
      fail(409, 'FOCUS_SOURCE_CHANGED', '复习题目已变化，请重新开始');
    return {
      ...identity,
      key: reviewCardId(identity),
      sourceUpdatedAt: original.updatedAt || original.createdAt || stamp,
      sourceFingerprint: fingerprint(original),
      startedElapsedSeconds: 0,
      question: leaf,
      phase: 'recall',
      mode: 'mental',
    };
  });
}
export function createFocus(
  store: Store,
  input: z.infer<typeof createFocusSchema>,
  context?: {
    learningDayId: string;
    paperId?: string;
    learningGoalId?: string;
    title: string;
    identities: Array<{
      questionId: string;
      partId?: string;
      direction: ReviewDirection;
      paperId?: string;
      paperTitle?: string;
      paperVersion?: number;
    }>;
  },
): FocusSession {
  const settings = getSettings(store),
    stamp = now(),
    paper = input.paperId ? store.require<StoredPaper>('papers', input.paperId) : undefined;
  if (paper?.archived) fail(409, 'FOCUS_PAPER_ARCHIVED', '恢复题集后再开始专注复习');
  if (!paper && !context && input.scope === 'all')
    fail(400, 'FOCUS_SCOPE_REQUIRED', '全部题目复习需要指定题集');
  const members = paper ? new Set(paper.questionIds) : null;
  const selected: Array<{ questionId: string; partId?: string; direction: ReviewDirection }> = [];
  if (context) selected.push(...context.identities.slice(0, input.count));
  else if (input.scope === 'due' && settings.reviewScheduling.strategy === 'fixed') {
    const metadata = store.questionMetadata({
      status: 'published',
      due: 'true',
      ...(input.domainId ? { domainId: input.domainId } : {}),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    });
    for (const row of metadata) {
      if (members && !members.has(row.id)) continue;
      const question = store.require<Question>('questions', row.id);
      for (const leaf of flattenQuestions([question])) {
        const explicit = leaf.partId
          ? store.get<StudyState>('study_parts', studyPartKey(question.id, leaf.partId))
          : store.study(question.id);
        const dueAt = explicit ? explicit.nextReviewAt : store.study(question.id).nextReviewAt;
        if (!dueAt || Date.parse(dueAt) > Date.now()) continue;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (
          input.kind === 'relearning' ||
          (input.kind === 'overdue' && Date.parse(dueAt) >= today.getTime()) ||
          (input.kind === 'today' && Date.parse(dueAt) < today.getTime())
        )
          continue;
        const direction =
          input.direction ||
          (!leaf.partId && (question.vocabulary || question.concept)
            ? 'word_to_meaning'
            : 'standard');
        if (
          direction === 'meaning_to_word' &&
          ((!question.vocabulary && !question.concept) ||
            question.vocabulary?.reverseEnabled === false ||
            leaf.partId)
        )
          continue;
        selected.push({
          questionId: question.id,
          ...(leaf.partId ? { partId: leaf.partId } : {}),
          direction,
        });
        if (selected.length >= input.count) break;
      }
      if (selected.length >= input.count) break;
    }
  } else if (input.scope === 'due') {
    const queue = reviewQueue(store, {
      page: 1,
      pageSize: 1_500_000,
      kind: input.kind,
      domainId: input.domainId,
      categoryId: input.categoryId,
      direction: input.direction,
    });
    selected.push(
      ...queue.items
        .filter((item) => !members || members.has(item.questionId))
        .slice(0, input.count),
    );
  } else {
    const ids = [...paper!.questionIds];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    for (const id of ids) {
      const question = store.get<Question>('questions', id);
      if (!question || question.status !== 'published') continue;
      const direction =
        input.direction ||
        (question.vocabulary || question.concept ? 'word_to_meaning' : 'standard');
      if (
        direction === 'meaning_to_word' &&
        ((!question.vocabulary && !question.concept) ||
          question.vocabulary?.reverseEnabled === false)
      )
        continue;
      for (const leaf of flattenQuestions([question])) {
        selected.push({
          questionId: id,
          ...(leaf.partId ? { partId: leaf.partId } : {}),
          direction: leaf.partId ? 'standard' : direction,
        });
        if (selected.length >= input.count) break;
      }
      if (selected.length >= input.count) break;
    }
  }
  if (!selected.length)
    fail(
      422,
      'FOCUS_EMPTY',
      input.scope === 'due'
        ? '当前范围没有到期复习任务，可选择题集全部题目。'
        : '当前题集没有符合方向的已发布题目',
    );
  const items = createFocusItems(store, selected, stamp);
  const session: FocusSession = {
    id: makeId('focus'),
    paperId: paper?.id || context?.paperId || null,
    title: context?.title || paper?.title || '待复习',
    ...(context
      ? {
          learningDayId: context.learningDayId,
          ...(context.learningGoalId ? { learningGoalId: context.learningGoalId } : {}),
        }
      : {}),
    paperVersion: paper?.version || 1,
    scope: input.scope,
    strategy: settings.reviewScheduling.strategy,
    status: 'in_progress',
    practiceMode: 'practice',
    revision: 1,
    items,
    index: 0,
    startedAt: stamp,
    updatedAt: stamp,
    submittedAt: null,
    elapsedSeconds: 0,
    practiceTiming: initialPracticeTiming(),
  };
  store.transaction(() => {
    saveFocus(store, session);
    for (const row of focusRetentionCandidates(store, settings, {
      paperId: session.paperId,
      learningDayId: session.learningDayId || null,
      status: 'in_progress',
      preserveId: session.id,
    }))
      store.remove('focus_sessions', row.id);
  });
  return session;
}
function sourceAvailable(store: Store, item: FocusItem) {
  const question = store.get<Question>('questions', item.questionId);
  if (
    !question ||
    question.status !== 'published' ||
    fingerprint(question) !== item.sourceFingerprint
  )
    fail(
      409,
      'FOCUS_SOURCE_CHANGED',
      '原题已修改、归档或删除；请跳过本题，并重新开始复习以使用最新内容',
    );
}
function actualAttempt(store: Store, session: FocusSession, item: FocusItem): StoredAttempt {
  const stamp = now(),
    elapsedSeconds = Math.max(0, session.elapsedSeconds - item.startedElapsedSeconds);
  const attempt: StoredAttempt = {
    id: makeId('attempt'),
    focusSessionId: session.id,
    ...(session.learningDayId ? { learningDayId: session.learningDayId } : {}),
    ...(session.learningGoalId ? { learningGoalId: session.learningGoalId } : {}),
    source: item.paperId || session.paperId ? 'paper' : 'quick',
    paperId: item.paperId || session.paperId || QUICK_PAPER_ID,
    paperTitle: `专注复习 · ${item.paperTitle || session.title}`.slice(0, 300),
    paperVersion: item.paperVersion || session.paperVersion,
    status: 'in_progress',
    practiceMode: 'practice',
    practiceTiming: initialPracticeTiming({ elapsedSeconds }),
    elapsedSeconds,
    questions: [structuredClone(item.question)],
    scoring: normalizeScoring([item.question], { enabled: false }),
    answers: {},
    objectiveScore: 0,
    objectiveMax: 0,
    subjectiveScore: 0,
    subjectiveMax: 0,
    startedAt: stamp,
    updatedAt: stamp,
    submittedAt: null,
    ...(item.direction !== 'standard' ? { vocabularyDirection: item.direction } : {}),
    practiceKind: item.question.concept
      ? 'concept'
      : item.question.vocabulary
        ? 'vocabulary'
        : 'standard',
  };
  store.insert('attempts', attempt.id, attempt);
  submitAttempt(store, attempt, { [item.question.id]: item.answer! });
  return attempt;
}
export function actFocus(
  store: Store,
  session: FocusSession,
  input: z.infer<typeof focusActionSchema>,
): FocusSession {
  const previous = session.items[input.index];
  if (
    input.action === 'rate' &&
    previous?.phase === 'rated' &&
    previous.rating === input.rating &&
    previous.verdict === (input.verdict ?? null)
  )
    return session;
  if (input.action === 'reveal' && previous?.phase === 'revealed' && input.index === session.index)
    return session;
  if (session.status !== 'in_progress' || session.reset)
    fail(409, 'FOCUS_FINISHED', '本次复习已结束');
  if (session.revision !== input.revision || session.index !== input.index)
    fail(409, 'FOCUS_VERSION_CONFLICT', '复习进度已在其他页面更新，请重新进入继续');
  const item = session.items[session.index]!;
  store.transaction(() => {
    if (input.action === 'save' || input.action === 'reveal') {
      if (item.phase !== 'recall')
        fail(409, 'FOCUS_ALREADY_REVEALED', '核对答案后不能再修改原回答');
      item.mode = input.mode || item.mode;
      item.answer =
        input.answer === undefined
          ? item.answer
          : {
              value: input.answer,
              ...((input.mathEnabled ?? item.answer?.mathEnabled) !== undefined
                ? { mathEnabled: input.mathEnabled ?? item.answer?.mathEnabled }
                : {}),
            };
      if (input.action === 'reveal') {
        sourceAvailable(store, item);
        if (item.mode === 'written') {
          if (!isAnswerPresent(item.answer))
            fail(400, 'FOCUS_EMPTY_ANSWER', '请先填写回答，或选择心答自评');
          validateAssetReferences(store, item.answer, getSettings(store));
          item.attemptId = actualAttempt(store, session, item).id;
        } else delete item.answer;
        item.phase = 'revealed';
      }
    } else if (input.action === 'rate') {
      if (item.phase !== 'revealed' || !input.rating)
        fail(400, 'FOCUS_REVEAL_REQUIRED', '请先核对答案，再记录回忆评级');
      sourceAvailable(store, item);
      if (getSettings(store).reviewScheduling.strategy !== session.strategy)
        fail(409, 'FOCUS_STRATEGY_CHANGED', '复习策略已修改，请暂存并使用当前策略新建会话');
      if (
        item.mode === 'written' &&
        !isSubjectiveType(item.question.type) &&
        !getObjectiveCorrect(item.question, item.answer) &&
        input.rating !== 'again'
      )
        fail(400, 'FOCUS_RATING_CONFLICT', '实际回答错误时，请选择重学');
      if (input.verdict && input.verdict !== 'correct' && input.rating !== 'again')
        fail(400, 'FOCUS_RATING_CONFLICT', '有错误或关键遗漏时，请选择重学');
      if (item.attemptId && isSubjectiveType(item.question.type) && input.verdict) {
        const attempt = store.get<StoredAttempt>('attempts', item.attemptId);
        if (!attempt)
          fail(
            409,
            'FOCUS_ANSWER_HISTORY_REMOVED',
            '本次实际作答历史已清理，不能修改判定；可保留未判继续记录回忆评级',
          );
        reviewAttempt(store, attempt!, {}, {}, { [item.question.id]: input.verdict });
      }
      item.verdict = input.verdict ?? null;
      if (session.strategy === 'fsrs')
        item.dueAt = recordManualReview(
          store,
          {
            questionId: item.questionId,
            partId: item.partId,
            direction: item.direction,
            rating: input.rating!,
            requestId: `${session.id}-${input.index}`,
          },
          undefined,
          { learningDayId: session.learningDayId },
        ).dueAt;
      else {
        const mastery = ({ again: 0, hard: 1, good: 2, easy: 3 } as const)[input.rating!],
          stamp = now();
        const state = {
          ...store.study(item.questionId, item.partId),
          mastery,
          lastReviewedAt: stamp,
          nextReviewAt: new Date(
            Date.now() + getSettings(store).reviewIntervalsDays[mastery]! * 86400000,
          ).toISOString(),
        };
        store.putStudy(state);
        const id = `${session.id}-${input.index}`;
        store.put('reviews', id, {
          id,
          questionId: item.questionId,
          ...(item.partId ? { partId: item.partId } : {}),
          mastery,
          reviewedAt: stamp,
          source: 'focus',
          rating: input.rating,
        });
        recordPlanEvidence(store, [
          {
            dayId: session.learningDayId,
            questionId: item.questionId,
            partId: item.partId,
            direction: item.direction,
            kind: 'review',
            at: stamp,
            sourceId: id,
          },
        ]);
        item.dueAt = state.nextReviewAt;
      }
      item.rating = input.rating;
      item.phase = 'rated';
    } else item.phase = 'skipped';
    if (input.action === 'rate' || input.action === 'skip') {
      session.index++;
      if (session.index >= session.items.length) {
        session.status = 'submitted';
        session.submittedAt = now();
        freezePracticeTiming(session);
      } else session.items[session.index]!.startedElapsedSeconds = session.elapsedSeconds;
    }
    session.revision++;
    session.updatedAt = nextStamp(session.updatedAt);
    saveFocus(store, session);
  });
  return session;
}
