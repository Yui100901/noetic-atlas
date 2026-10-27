import { z } from 'zod';
import type { Attempt, PracticeTiming } from '../../../shared/models/types.js';
import { Store, nextStamp, now } from '../../core/store.js';
import { fail, id } from '../../core/validation.js';

const milliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionMilliseconds = milliseconds.max(31 * 86400 * 1000);
export const practiceTimingStateSchema = z.object({
  elapsedMilliseconds: milliseconds, sessionId: id.nullable(),
  sessionElapsedMilliseconds: sessionMilliseconds, sessionStartedAt: z.string().datetime({ offset: true }).nullable(), running: z.boolean(),
}).strict().superRefine((state, context) => {
  if (state.sessionElapsedMilliseconds > state.elapsedMilliseconds || (state.sessionId === null) !== (state.sessionStartedAt === null) || state.sessionId === null && (state.running || state.sessionElapsedMilliseconds !== 0)) context.addIssue({ code: 'custom', message: '练习计时会话与累计值不一致' });
});
export const practiceTimingInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resume'), sessionId: id, expectedSessionId: id.nullable() }).strict(),
  z.object({ action: z.literal('checkpoint'), sessionId: id, elapsedMilliseconds: sessionMilliseconds }).strict(),
  z.object({ action: z.literal('pause'), sessionId: id, elapsedMilliseconds: sessionMilliseconds }).strict(),
]);
export type PracticeTimingInput = z.infer<typeof practiceTimingInputSchema>;
type TimedAttempt = Pick<Attempt, 'practiceMode' | 'practiceTiming' | 'elapsedSeconds' | 'status'>;

/** Legacy in-progress elapsed values are the last saved checkpoint. Never
 * backfill the unobserved gap from startedAt or from the current wall clock. */
export function initialPracticeTiming(attempt: Pick<Attempt, 'elapsedSeconds'> = {}): PracticeTiming {
  const seconds = Number.isSafeInteger(attempt.elapsedSeconds) && attempt.elapsedSeconds! >= 0 ? attempt.elapsedSeconds! : 0;
  if (!Number.isSafeInteger(seconds * 1000)) fail(400, 'INVALID_ATTEMPT_TIMING', '原有练习计时超过可保存范围');
  return { elapsedMilliseconds: seconds * 1000, sessionId: null, sessionElapsedMilliseconds: 0, sessionStartedAt: null, running: false };
}
export function freezePracticeTiming(attempt: TimedAttempt) {
  if (attempt.practiceMode === 'exam') return;
  attempt.practiceTiming = { ...(attempt.practiceTiming || initialPracticeTiming(attempt)), running: false };
  attempt.elapsedSeconds = Math.floor(attempt.practiceTiming.elapsedMilliseconds / 1000);
}
export function validatePracticeTiming(attempt: TimedAttempt) {
  if (!attempt.practiceTiming) return;
  const parsed = practiceTimingStateSchema.safeParse(attempt.practiceTiming);
  if (!parsed.success || attempt.practiceMode === 'exam' || attempt.status === 'submitted' && attempt.practiceTiming.running || attempt.elapsedSeconds !== Math.floor(attempt.practiceTiming.elapsedMilliseconds / 1000)) fail(400, 'INVALID_ATTEMPT_TIMING', '普通练习累计计时或会话状态不一致');
}

/** Each page reports the monotonically increasing duration of one visible
 * session. Only a new maximum contributes a delta; timestamps do not add time.
 * A missing final unload event can lose the last checkpoint interval, but can
 * never charge the hours/days spent outside the practice page. */
export function updatePracticeTiming<T extends TimedAttempt & Pick<Attempt, 'id' | 'updatedAt' | 'startedAt'>>(store: Store, attempt: T, input: PracticeTimingInput): T {
  if (attempt.practiceMode === 'exam') fail(409, 'EXAM_TIMER_CONTINUES', '考试使用固定倒计时，不能暂停或更改计时');
  if (attempt.status === 'submitted') return attempt;
  const previous = attempt.practiceTiming || initialPracticeTiming(attempt);
  let next: PracticeTiming;
  if (input.action === 'resume') {
    if (previous.sessionId === input.sessionId) return attempt;
    if (input.expectedSessionId !== previous.sessionId) fail(409, 'PRACTICE_TIMING_SESSION_CHANGED', '练习计时已由其他答题页面恢复，请重新进入本次练习');
    next = { elapsedMilliseconds: previous.elapsedMilliseconds, sessionId: input.sessionId, sessionElapsedMilliseconds: 0, sessionStartedAt: now(), running: true };
  } else {
    if (!previous.running || previous.sessionId !== input.sessionId) return attempt;
    const maximum = Math.max(previous.sessionElapsedMilliseconds, input.elapsedMilliseconds);
    const elapsed = previous.elapsedMilliseconds + maximum - previous.sessionElapsedMilliseconds;
    if (!Number.isSafeInteger(elapsed)) fail(400, 'INVALID_ATTEMPT_TIMING', '累计练习时长超过可保存范围');
    next = { ...previous, elapsedMilliseconds: elapsed, sessionElapsedMilliseconds: maximum, running: input.action !== 'pause' };
    if (next.elapsedMilliseconds === previous.elapsedMilliseconds && next.running === previous.running) return attempt;
  }
  attempt.practiceTiming = next; attempt.elapsedSeconds = Math.floor(next.elapsedMilliseconds / 1000);
  attempt.updatedAt = nextStamp(attempt.updatedAt || attempt.startedAt);
  store.put('attempts', attempt.id, attempt);
  return attempt;
}
