import {QualitySource} from '../content-quality/quality-source';
import { useEffect, useState } from 'react';
import { AlertCircle, Check, Search, Sparkles, X } from 'lucide-react';
import { QUESTION_FEEDBACK_KIND_LABELS, QUESTION_FEEDBACK_STATUS_LABELS, QUESTION_FEEDBACK_VERDICT_LABELS, type FeedbackCandidates, type QuestionFeedbackStatus, type QuestionFeedbackView } from '../../../shared/models/question-feedback';
import type { Question } from '../../../shared/models/types';
import { idPath, localDate, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, Markdown } from '../../shared/ui/components';
import { notifyFeedbackChanged } from './feedback-state';

const relationLabels: Record<string, string> = { similar: '相似内容', conflict: '可能冲突', supports: '支持反馈', unrelated: '关联不足' };
export function FeedbackDetail({ feedback, busy, onReview, onUpdated, onClose, embedded = false }: { feedback: QuestionFeedbackView; busy: boolean; onReview: () => void; onUpdated: (feedback: QuestionFeedbackView) => void; onClose: () => void; embedded?: boolean }) {
  const source = useResource<Question>(!embedded && feedback.sourceAvailable ? `/api/questions/${idPath(feedback.questionId)}` : null);
  const [compare, setCompare] = useState(false), [note, setNote] = useState(feedback.note || ''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const candidates = useResource<FeedbackCandidates>(compare ? `/api/question-feedback/${idPath(feedback.id)}/candidates` : null);
  useEffect(() => { setCompare(false); setNote(feedback.note || ''); setError(''); }, [feedback.id]);
  async function resolve(status: QuestionFeedbackStatus) {
    setSaving(true); setError('');
    try { const value = await send<QuestionFeedbackView>(`/api/question-feedback/${idPath(feedback.id)}/resolve`, 'POST', { status, note, expectedUpdatedAt: feedback.updatedAt }); onUpdated(value); notifyFeedbackChanged(); }
    catch (reason) { setError((reason as Error).message); } finally { setSaving(false); }
  }
  return <section className={`${embedded?'quality-feedback-evidence':'card'} form-stack feedback-detail`} aria-label={embedded?'反馈复核证据':'反馈核查详情'}>
    <div className="list-toolbar"><div><h2>{feedback.questionTitle}</h2><p className="muted">{QUESTION_FEEDBACK_KIND_LABELS[feedback.kind]} · {QUESTION_FEEDBACK_STATUS_LABELS[feedback.status]} · {localDate(feedback.createdAt)}{feedback.partId ? ` · 小题 ${feedback.partId}` : ''}</p></div><div className="feedback-actions">{!embedded&&<button type="button" className="button" disabled={busy || saving || !feedback.sourceAvailable} onClick={onReview}><Sparkles size={15} />AI复核本条</button>}<button type="button" className="button" disabled={busy || saving} onClick={() => setCompare(value => !value)}><Search size={15} />{compare ? '收起站内比对' : '站内查找相似与冲突'}</button>{!embedded&&<button type="button" className="button" disabled={saving} onClick={onClose}><X size={15} />收起详情</button>}</div></div>
    <div className="feedback-description"><strong>{feedback.origin==='quality'?'系统复核上下文':'用户反馈'}</strong><p>{feedback.description}</p></div>
    {feedback.sourceChanged && <p className="notice">原题在反馈提交后发生变化，请核对反馈是否仍适用于当前版本。</p>}
    {!feedback.sourceAvailable && <p className="notice">原题或对应小题已不可用，仍保留反馈与已有核查记录。</p>}
    {!embedded&&(source.loading && feedback.sourceAvailable ? <Loading /> : source.error ? <ErrorNotice message={source.error} retry={source.refresh} /> : source.data && <details open><summary>当前原题与参考答案</summary><QualitySource question={source.data} partId={feedback.partId}/></details>)}
    {feedback.review && <div className="feedback-ai-review form-stack"><div><span className={`badge feedback-verdict-${feedback.review.verdict}`}>{QUESTION_FEEDBACK_VERDICT_LABELS[feedback.review.verdict]}</span><small className="muted"> AI复核建议 · {localDate(feedback.review.reviewedAt)} · 比较{feedback.review.candidateCount}条站内候选</small></div><Markdown>{feedback.review.reason}</Markdown>{feedback.review.suggestion && <><h3>建议处理</h3><Markdown>{feedback.review.suggestion}</Markdown></>}{feedback.review.comparisons.length > 0 && <ul>{feedback.review.comparisons.map((item, index) => <li key={index}><strong>{relationLabels[item.relation] || item.relation}</strong> · {item.questionId}{item.partId ? ` / ${item.partId}` : ''}：{item.reason}</li>)}</ul>}<a className="button" href={`#/ai?tab=history&run=${idPath(feedback.review.runId)}`}>查看本次AI处理记录</a><p className="muted">AI结果不会自动修改反馈状态、标准答案或题目发布状态。</p></div>}
    {feedback.lastFailure && <div className="notice error"><AlertCircle size={18} /><div><strong>上次AI复核失败：{feedback.lastFailure.failure.message}</strong><p>{feedback.lastFailure.failure.code} · {feedback.lastFailure.failure.recommendation}</p>{feedback.lastFailure.auditId && <a className="button" href={`#/ai?tab=history&run=${idPath(feedback.lastFailure.auditId)}`}>查看失败诊断</a>}</div></div>}
    {compare && <div className="feedback-candidates form-stack"><h3>站内相似与冲突候选</h3>{candidates.loading ? <Loading /> : candidates.error ? <ErrorNotice message={candidates.error} retry={candidates.refresh} /> : candidates.data && <><p className="muted">{candidates.data.scope} · 最多{candidates.data.limit}条。相似不代表重复或有误，请比较前提、选项和答案。</p>{candidates.data.items.length ? candidates.data.items.map(candidate => <details open key={candidate.id}><summary>{candidate.title} · {candidate.reason}</summary><div className="feedback-candidate-content"><QualitySource question={{...candidate,id:candidate.questionId}} partId={candidate.partId}/></div></details>) : <p className="muted">当前未检索到合适候选；这不代表反馈已被否定。</p>}</>}</div>}
    {!embedded&&<>
    <Field label="核查结论／处理备注" hint="标为已解决或忽略时必须填写依据、修订位置或忽略原因。"><textarea rows={3} maxLength={5000} value={note} disabled={busy || saving} onChange={event => setNote(event.target.value)} /></Field>
    {error && <ErrorNotice message={error} />}
    <div className="feedback-actions"><button type="button" className="button primary" disabled={busy || saving || feedback.status === 'confirmed'} onClick={() => void resolve('confirmed')}><Check size={15} />确认存在问题</button><button type="button" className="button" disabled={busy || saving || feedback.status === 'resolved' || !note.trim()} onClick={() => void resolve('resolved')}>标为已解决</button><button type="button" className="button" disabled={busy || saving || feedback.status === 'dismissed' || !note.trim()} onClick={() => void resolve('dismissed')}>忽略反馈</button><button type="button" className="button" disabled={busy || saving || feedback.status === 'pending'} onClick={() => void resolve('pending')}>重新待核查</button></div>
    </>}
  </section>;
}
