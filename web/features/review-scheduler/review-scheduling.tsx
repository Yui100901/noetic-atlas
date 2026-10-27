import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarClock, Pause, Play, RotateCcw } from 'lucide-react';
import type { AttemptReviewItem, AttemptReviewOverview, ReviewCardView, ReviewDirection, ReviewRating } from '../../../shared/models/adaptive-review';
import { REVIEW_RATING_LABELS } from '../../../shared/models/adaptive-review';
import { DEFAULT_REVIEW_SCHEDULING } from '../../../shared/models/settings';
import type { Attempt } from '../../../shared/models/types';
import { answerState } from '../../../shared/practice/attempt-timing';
import { idPath, localDate, qs, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, useApp } from '../../shared/ui/components';
import './review-scheduling.css';

const directionLabels: Record<ReviewDirection, string> = { standard: '普通练习', word_to_meaning: '顺向 · 看词想释义', meaning_to_word: '逆向 · 看释义想词' };
const stateLabels: Record<ReviewCardView['state'], string> = { new: '尚未建立回忆记录', learning: '初学中', review: '间隔复习', relearning: '重新学习中' };
const ratingHints: Record<ReviewRating, string> = { again: '想不起来、答错或关键遗漏', hard: '独立答对，但回忆吃力', good: '能正常独立回答', easy: '完整回答且几乎不费力' };
const localInput = (value: string | null) => { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const shortDue = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

export function ReviewSchedulingPanel({ questionId, partId, vocabulary = false, concept = false, direction: initialDirection, attemptId, leafId, onChanged, available = true, onlyAgain = false }: {
  questionId: string; partId?: string; vocabulary?: boolean; concept?: boolean; direction?: ReviewDirection; attemptId?: string; leafId?: string; onChanged?: () => void; available?: boolean; onlyAgain?: boolean;
}) {
  const { bootstrap, reload, toast } = useApp();
  const strategy = (bootstrap.settings?.reviewScheduling || DEFAULT_REVIEW_SCHEDULING).strategy;
  const [direction, setDirection] = useState<ReviewDirection>(initialDirection || (vocabulary ? 'word_to_meaning' : 'standard'));
  useEffect(() => { setDirection(initialDirection || (vocabulary ? 'word_to_meaning' : 'standard')); }, [questionId, partId, initialDirection, vocabulary]);
  const resource = useResource<ReviewCardView>(strategy === 'fsrs' && available ? `/api/review-scheduler/card?${qs({ questionId, partId, direction, attemptId, leafId })}` : null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dueAt, setDueAt] = useState('');
  const manualRequest = useRef<{ identity: string; rating: ReviewRating; id: string } | null>(null);
  useEffect(() => { setDueAt(localInput(resource.data?.dueAt || null)); }, [resource.data?.dueAt, direction]);
  if (strategy !== 'fsrs') return null;
  if (!available) return <p className="review-scheduling-help">题目发布后可记录自适应复习，现有笔记和掌握程度继续保留。</p>;
  const changed = () => { resource.refresh(); reload(); onChanged?.(); };
  const rate = async (rating: ReviewRating | null) => {
    setBusy(true); setError('');
    try {
      if (attemptId && leafId) await send(`/api/review-scheduler/attempts/${idPath(attemptId)}/rating`, 'POST', { leafId, rating });
      else if (rating) {
        const identity = JSON.stringify([questionId, partId || null, direction]);
        if (manualRequest.current?.identity !== identity || manualRequest.current.rating !== rating) manualRequest.current = { identity, rating, id: crypto.randomUUID() };
        await send('/api/review-scheduler/review', 'POST', { questionId, ...(partId ? { partId } : {}), direction, rating, requestId: manualRequest.current.id });
        manualRequest.current = null;
      }
      changed(); toast(rating ? `${attemptId ? '已更正本次' : '已记录'}回忆评级：${REVIEW_RATING_LABELS[rating]}` : '已恢复本次自动评级');
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  const configure = async (values: { suspended?: boolean; dueAt?: string | null }) => {
    setBusy(true); setError('');
    try { await send('/api/review-scheduler/card', 'PATCH', { questionId, ...(partId ? { partId } : {}), direction, ...values }); changed(); toast(values.suspended === undefined ? '复习日期已更新' : values.suspended ? '已暂停此项复习' : '已恢复此项复习'); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  const value = resource.data;
  return <div className="review-scheduling" aria-label={attemptId ? '本次回忆评级' : '自适应复习'}>
    <div className="review-scheduling-heading"><h3><CalendarClock size={16} />{attemptId ? '本次回忆评级' : '自适应复习'}</h3><span className="badge">FSRS</span></div>
    {vocabulary && !attemptId && !initialDirection && <div className="review-scheduling-direction"><Field label="复习方向"><select disabled={busy} value={direction} onChange={event => setDirection(event.target.value as ReviewDirection)}><option value="word_to_meaning">{concept ? '顺向 · 看概念想含义' : directionLabels.word_to_meaning}</option><option value="meaning_to_word">{concept ? '逆向 · 看描述想概念' : directionLabels.meaning_to_word}</option></select></Field></div>}
    {resource.loading ? <Loading text="正在计算复习安排…" /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : value && <>
      <p className="review-scheduling-summary">{value.suspended ? '已暂停自动复习' : stateLabels[value.state]}{value.latestRating ? ` · 最近${REVIEW_RATING_LABELS[value.latestRating]}` : ''}{attemptId ? ' · 更正只作用于原作答事件' : ''}</p>
      <dl className="review-scheduling-facts"><div><dt>下次复习</dt><dd>{value.suspended ? '暂停中' : localDate(value.dueAt)}</dd></div><div><dt>有效回忆记录</dt><dd>{value.eventCount} 次</dd></div>{value.card && <><div><dt>复习次数／遗忘次数</dt><dd>{value.card.memory.reps}／{value.card.memory.lapses}</dd></div><div><dt>最近复习</dt><dd>{localDate(value.lastReviewedAt)}</dd></div></>}</dl>
      {value.canReview ? <><div className="review-rating-buttons" role="group" aria-label="选择回忆评级">{value.preview.map(preview => <button type="button" key={preview.rating} className={`rating-${preview.rating} ${value.latestRating === preview.rating ? 'selected' : ''}`} disabled={busy || onlyAgain && preview.rating !== 'again'} title={onlyAgain && preview.rating !== 'again' ? '本次回答错误、有关键遗漏或提前查看参考，需选择重学' : `${ratingHints[preview.rating]}；下次${localDate(preview.dueAt)}`} onClick={() => void rate(preview.rating)}><strong>{REVIEW_RATING_LABELS[preview.rating]}</strong><small>下次 {shortDue(preview.dueAt)}</small></button>)}</div><p className="review-scheduling-help">{onlyAgain ? '本次回答错误、有关键遗漏或提前查看参考，仅能记录“重学”；完成一次独立正确回忆后可选择其他评级。' : '先独立回忆并核对答案，再选择。“困难”表示完整答对但吃力；关键遗漏请选择“重学”。'}</p></> : <p className="review-scheduling-help">{value.reason || '当前不能记录回忆评级。'}</p>}
      {attemptId && value.canReview && <button type="button" className="text-button" disabled={busy} onClick={() => void rate(null)}><RotateCcw size={12} />恢复本次自动评级</button>}
      {!attemptId && <details className="review-scheduling-controls"><summary>暂停或调整复习日期</summary><div className="review-scheduling-actions"><button type="button" className="button" disabled={busy} onClick={() => void configure({ suspended: !value.suspended })}>{value.suspended ? <Play size={13} /> : <Pause size={13} />}{value.suspended ? '恢复复习' : '暂停复习'}</button></div><Field label="下次复习时间" hint="按设备本地时间设置，不增加复习次数。"><input type="datetime-local" value={dueAt} disabled={busy} onChange={event => setDueAt(event.target.value)} /></Field><div className="review-scheduling-actions"><button type="button" className="button" disabled={busy || !dueAt} onClick={() => { const timestamp = new Date(dueAt); if (!Number.isFinite(timestamp.getTime())) { setError('请选择有效日期和时间'); return; } void configure({ dueAt: timestamp.toISOString() }); }}>保存复习时间</button><button type="button" className="button" disabled={busy} onClick={() => void configure({ dueAt: null })}>恢复算法排期</button></div></details>}
    </>}{error && <ErrorNotice message={error} />}
  </div>;
}

interface AttemptReviewContextValue { attempt: Attempt; data: AttemptReviewOverview | null; loading: boolean; error: string; refresh: () => void }
const AttemptReviewContext = createContext<AttemptReviewContextValue | null>(null);
export function AttemptReviewProvider({ attempt, children }: { attempt: Attempt; children: ReactNode }) {
  const { bootstrap } = useApp();
  const enabled = (bootstrap.settings?.reviewScheduling || DEFAULT_REVIEW_SCHEDULING).strategy === 'fsrs' && attempt.status === 'submitted';
  const resource = useResource<AttemptReviewOverview>(enabled ? `/api/review-scheduler/attempts/${idPath(attempt.id)}` : null);
  const token = `${attempt.id}:${attempt.updatedAt || attempt.submittedAt || ''}:${attempt.status}`, seen = useRef(token);
  useEffect(() => { if (seen.current !== token) { seen.current = token; resource.refresh(); } }, [token, resource.refresh]);
  return <AttemptReviewContext.Provider value={{ attempt, data: resource.data, loading: resource.loading, error: resource.error, refresh: resource.refresh }}>{children}</AttemptReviewContext.Provider>;
}
export function AttemptReviewSummary() {
  const context = useContext(AttemptReviewContext), { bootstrap } = useApp();
  if (!context || context.attempt.status !== 'submitted' || (bootstrap.settings?.reviewScheduling || DEFAULT_REVIEW_SCHEDULING).strategy !== 'fsrs') return null;
  if (context.error) return <ErrorNotice message={`自适应复习记录读取失败：${context.error}`} retry={context.refresh} />;
  if (context.loading) return <p className="review-scheduling-help">正在读取本次复习安排…</p>;
  return <div className="notice info"><CalendarClock size={17} /><span>FSRS已记录 {context.data?.items.filter(item => item.eventId).length || 0} 项回忆。可在各题下方更正本次评级；掌握程度、分数与回忆评级分别记录，漏答和未判不更新记忆。</span></div>;
}
export function AttemptReviewControls({ leafId, onChanged }: { leafId: string; onChanged?: () => void }) {
  const context = useContext(AttemptReviewContext); const [open, setOpen] = useState(false);
  const item: AttemptReviewItem | undefined = context?.data?.items.find(value => value.leafId === leafId);
  if (!context || !item) return null;
  const question = context.attempt.questions.find(value => value.id === leafId);
  const state = context.attempt.answerStates?.[leafId] || (question ? answerState(question, context.attempt.answers[leafId], true, question.points ?? context.attempt.scoring?.questionPoints[leafId]) : 'ungraded');
  const onlyAgain = state !== 'correct' || !!context.attempt.referenceViewedAt;
  return <details className="attempt-review-scheduling" onToggle={event => setOpen(event.currentTarget.open)}><summary><CalendarClock size={15} />自适应复习<small>{item.rating ? `${item.ratingSource === 'automatic' ? '已自动记录' : '已确认'}${REVIEW_RATING_LABELS[item.rating]}` : item.eligible ? '确认本次回忆质量' : '暂不更新记忆'}</small></summary>{open && (item.eligible ? <ReviewSchedulingPanel questionId={item.questionId} partId={item.partId} direction={item.direction} attemptId={context.attempt.id} leafId={leafId} onlyAgain={onlyAgain} onChanged={() => { context.refresh(); onChanged?.(); }} /> : <p className="review-scheduling-summary">{item.reason || '本题未满足记录回忆的条件。'}</p>)}</details>;
}
