import { useState } from 'react';
import { AlertTriangle, MessageSquareWarning, Send } from 'lucide-react';
import type { Question } from '../../../shared/models/types';
import { QUESTION_FEEDBACK_KIND_LABELS, type QuestionFeedbackInput, type QuestionFeedbackKind, type QuestionFeedbackSummary } from '../../../shared/models/question-feedback';
import { idPath, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, Markdown, Modal, useApp } from '../../shared/ui/components';
import { notifyFeedbackChanged, useFeedbackSummary, useFeedbackSummaries } from './feedback-state';
import './question-feedback.css';

export function QuestionFeedbackBadge({ questionId, partId, summary }: { questionId: string; partId?: string; summary?: QuestionFeedbackSummary }) {
  const contextual = useFeedbackSummary(questionId), value = summary || contextual;
  const count = value ? partId !== undefined ? (value.wholeCount || 0) + (value.partCounts?.[partId] || 0) : value.openCount : 0;
  return count ? <span className="question-feedback-badge" title={`有${count}条待核查或已确认的问题反馈；不表示题目一定有误。`}><AlertTriangle size={13} />疑似问题 · {count}</span> : null;
}

export function ReportQuestionAction({ questionId, partId, snapshotDifferent = false, disabled = false }: { questionId: string; partId?: string; snapshotDifferent?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false), summaries = useFeedbackSummaries([questionId]);
  return <div className="question-feedback-action"><QuestionFeedbackBadge questionId={questionId} partId={partId} summary={summaries[questionId]} /><button className="button" type="button" disabled={disabled} onClick={() => setOpen(true)}><MessageSquareWarning size={15} />{partId ? '反馈本小题' : '反馈题目问题'}</button>{open && <ReportQuestionDialog questionId={questionId} partId={partId} snapshotDifferent={snapshotDifferent} onClose={() => setOpen(false)} />}</div>;
}

export function ReportQuestionDialog({ questionId, partId, snapshotDifferent = false, onClose }: { questionId: string; partId?: string; snapshotDifferent?: boolean; onClose: () => void }) {
  const { toast } = useApp(), source = useResource<Question>(`/api/questions/${idPath(questionId)}`);
  const [kind, setKind] = useState<QuestionFeedbackKind>('answer'), [description, setDescription] = useState(''), [selectedPart, setSelectedPart] = useState(partId || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const part = selectedPart ? source.data?.parts?.find(value => value.id === selectedPart) : undefined;
  const valid = !!source.data && (!selectedPart || !!part);
  async function submit() {
    if (!source.data || !description.trim() || !valid) return;
    setBusy(true); setError('');
    const payload: QuestionFeedbackInput = { questionId, ...(selectedPart ? { partId: selectedPart } : {}), kind, description: description.trim(), ...(source.data.updatedAt ? { expectedUpdatedAt: source.data.updatedAt } : {}) };
    try { await send('/api/question-feedback', 'POST', payload); notifyFeedbackChanged(); toast('反馈已提交并进入质量管理待处理，题目将显示疑似问题标记'); onClose(); }
    catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  return <Modal title="反馈题目问题" onClose={() => { if (!busy) onClose(); }} wide><div className="form-stack question-feedback-form">
    <p className="muted">反馈进入待核查区，原题发布状态和历史作答保持原样。可说明问题位置、正确内容或可核对的依据。</p>
    {source.loading ? <Loading /> : source.error ? <ErrorNotice message={source.error} retry={source.refresh} /> : source.data && <>
      <strong>{source.data.title}</strong>
      {source.data.type === 'group' && <Field label="反馈范围"><select value={selectedPart} disabled={busy} onChange={event => setSelectedPart(event.target.value)}><option value="">整组／公共材料</option>{source.data.parts?.map((value, index) => <option value={value.id} key={value.id}>小题{index + 1} · {value.title}</option>)}</select></Field>}
      {snapshotDifferent && <p className="notice">当前页面展示题集旧快照。此反馈针对现存原题，请先核对下方当前内容。</p>}
      <details open={snapshotDifferent}><summary>核对本次反馈的当前题目内容</summary><div className="feedback-question-context">{part && <><h4>公共材料</h4><Markdown>{source.data.stemMarkdown}</Markdown></>}<Markdown>{part?.stemMarkdown || source.data.stemMarkdown}</Markdown>{(part?.options || source.data.options).map(option => <p key={option.key}>{option.key}. {option.text}</p>)}<h4>参考答案</h4><Markdown>{part?.answerMarkdown || source.data.answerMarkdown}</Markdown><h4>解析</h4><Markdown>{part?.explanationMarkdown || source.data.explanationMarkdown}</Markdown></div></details>
      <Field label="问题类型"><select value={kind} disabled={busy} onChange={event => setKind(event.target.value as QuestionFeedbackKind)}>{Object.entries(QUESTION_FEEDBACK_KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label="问题描述与依据" hint="例如：答案与解析不一致、缺少某个条件，或指出疑似重复题号；没有依据时可以说明疑问。"><textarea rows={5} maxLength={5000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></Field>
      {!valid && <ErrorNotice message="当前小题已不存在，请重新选择反馈范围。" />}
      {error && <ErrorNotice message={error} retry={source.refresh} />}
      <div className="form-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !valid || !description.trim()} onClick={() => void submit()}><Send size={15} />{busy ? '正在提交…' : '提交反馈'}</button></div>
    </>}
  </div></Modal>;
}
