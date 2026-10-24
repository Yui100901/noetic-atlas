import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { BookOpen, Bookmark, ChevronDown, Star } from 'lucide-react';
import type { Question, StudyState } from '../../../shared/models/types';
import { idPath, localDate, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, QuestionMeta, Tags, useApp } from '../../shared/ui/components';
import { QuestionContent, SourceNoticeScope, questionNoticeContents } from '../../shared/ui/content-notices';
import { QuestionStructuredBody } from './question-structure';
import { matchesQuestionSnapshot } from './question-viewer-state';
import './question-viewer.css';

export interface QuestionSnapshot extends Question {
  sourceQuestionId?: string;
  groupTitle?: string;
  groupStemMarkdown?: string;
}
export interface QuestionViewerHandle { confirmLeave: () => boolean }

/** Read immutable content from the set, and bind only learning state to the
 * original question. An edited/deleted original never replaces this snapshot. */
export const QuestionViewer = forwardRef<QuestionViewerHandle, { question: QuestionSnapshot; onStudyChange?: () => void; contentSource?: 'snapshot' | 'current' }>(function QuestionViewer({ question, onStudyChange, contentSource = 'snapshot' }, ref) {
  const sourceId = question.sourceQuestionId || question.id;
  const source = useResource<Question>(`/api/questions/${idPath(sourceId)}`);
  const { toast, reload } = useApp();
  const [answerOpen, setAnswerOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [busy, setBusy] = useState(false);
  const study = source.data?.study;
  const dirty = notes !== (study?.notes || '');
  useImperativeHandle(ref, () => ({ confirmLeave: () => !busy && (!dirty || confirm('学习笔记尚未保存，确定离开这道题？')) }), [busy, dirty]);
  useEffect(() => { setNotes(study?.notes || ''); }, [sourceId, study?.notes]);
  useEffect(() => { setReviewDate(study?.nextReviewAt?.slice(0, 10) || ''); }, [sourceId, study?.nextReviewAt]);
  const updateStudy = async (value: Partial<StudyState>, review = false) => {
    if (!source.data || source.error) return;
    setBusy(true);
    try {
      const state = await send<StudyState>(`/api/study/${idPath(sourceId)}${review ? '/review' : ''}`, review ? 'POST' : 'PUT', value);
      source.setData({ ...source.data, study: state });
      toast(review ? '已记录复习，并安排下次复习' : '学习记录已保存'); reload(); onStudyChange?.();
    } catch (reason) { toast((reason as Error).message, true); } finally { setBusy(false); }
  };
  const live = !!source.data && !source.error;
  const sameContent = live && matchesQuestionSnapshot(question, source.data!);
  return <div className="question-viewer" onClickCapture={event => {
    const link = (event.target as HTMLElement).closest('a');
    // Opening linked vocabulary or settings in this dialog must not discard the
    // set's paging and the currently selected question.
    if (link?.getAttribute('href')?.startsWith('#/')) { event.preventDefault(); toast('请先关闭看题窗口，再打开其他页面'); }
  }}>
    <SourceNoticeScope contents={questionNoticeContents(question)}>
      <section className="question-viewer-reading question-body">
        <QuestionMeta question={question} /><h3 className="question-viewer-title">{question.title}</h3>
        {question.groupStemMarkdown && <section className="group-material"><span className="section-label">共用材料 · {question.groupTitle}</span><QuestionContent>{question.groupStemMarkdown}</QuestionContent></section>}
        <QuestionContent>{question.stemMarkdown}</QuestionContent>
        {!!question.options.length && <div className="read-options">{question.options.map(option => <div key={option.key}><strong>{option.key}</strong><QuestionContent>{option.text}</QuestionContent></div>)}</div>}
        <QuestionStructuredBody question={question} /><Tags ids={question.tagIds} max={30} />
        <div className="answer-toggle"><button type="button" className={`button ${answerOpen ? '' : 'primary'}`} aria-expanded={answerOpen} onClick={() => setAnswerOpen(value => !value)}><BookOpen size={17} />{answerOpen ? '收起参考答案' : '展开答案与解析'}<ChevronDown size={15} className={answerOpen ? 'rotated' : ''} /></button></div>
        {answerOpen && <div className="answer-content"><div className="section-label">参考答案{question.correctAnswers.length ? ` · ${question.correctAnswers.map(value => value === 'true' ? '对' : value === 'false' ? '错' : value).join('、')}` : ''}</div><QuestionStructuredBody question={question} showAnswers /><QuestionContent>{question.answerMarkdown}</QuestionContent>{question.explanationMarkdown && <><div className="section-label">解析 · 追问 · 误区</div><QuestionContent>{question.explanationMarkdown}</QuestionContent></>}</div>}
      </section>
    </SourceNoticeScope>
    {source.loading ? <Loading text="正在读取学习记录…" /> : !live ? <div className="notice info">{contentSource === 'current' ? '当前原题已删除或暂时无法读取，仍展示打开窗口时读取的内容；关闭窗口刷新后重新确认。' : '原题已删除或暂时无法读取，仍可查看题集保存的完整题目与解析。'}当前无法保存原题学习记录。{source.error && <button type="button" className="text-button" onClick={source.refresh}>重试学习记录</button>}</div> : <>
      <section className="card question-viewer-study">
        <div className="list-toolbar"><h3><Bookmark size={17} />学习进度与笔记</h3><button type="button" className={`button ${study?.favorite ? 'favorited' : ''}`} disabled={busy} onClick={() => void updateStudy({ favorite: !study?.favorite })}><Star size={16} fill={study?.favorite ? 'currentColor' : 'none'} />{study?.favorite ? '已收藏' : '收藏'}</button></div>
        <p className="muted">收藏、掌握程度与笔记同步到原题{question.groupStemMarkdown ? '（本组小题共用学习记录）' : ''}。</p>
        <div className="mastery-buttons">{[0, 1, 2, 3].map(value => <button type="button" key={value} className={study?.mastery === value ? 'selected' : ''} disabled={busy} onClick={() => void updateStudy({ mastery: value }, true)}><span>{value}</span>{['不会', '需提示', '能独立', '能深入'][value]}</button>)}</div>
        <p className="muted">最近复习：{localDate(study?.lastReviewedAt)}　下次复习：{localDate(study?.nextReviewAt)}</p>
        <Field label="调整复习日期"><input type="date" value={reviewDate} onChange={event => setReviewDate(event.target.value)} /></Field><button type="button" className="button" disabled={busy} onClick={() => void updateStudy({ nextReviewAt: reviewDate ? new Date(`${reviewDate}T09:00:00`).toISOString() : null })}>更新日期</button>
        <Field label="我的学习笔记"><textarea rows={5} value={notes} onChange={event => setNotes(event.target.value)} placeholder="记录理解、错误原因和下一次要验证的问题…" /></Field>
        <div className="form-actions"><span className="muted">{dirty ? '有未保存的笔记' : '笔记已同步'}</span><button type="button" className="button primary" disabled={busy || !dirty} onClick={() => void updateStudy({ notes })}>保存笔记</button></div>
      </section>
      {contentSource === 'snapshot' && !sameContent && !question.groupStemMarkdown && <p className="muted">原题内容已修改，此处继续展示题集保存时的内容。学习记录仍与原题共用。</p>}
    </>}
    <p className="muted">{contentSource === 'current' ? '当前展示原题内容；收藏、复习与笔记共享原题学习记录。' : '题集保留保存时的内容；AI 解析可在知识题库中针对当前原题使用。'}</p>
    <section className="card sources-card"><details><summary>资料来源与常见度依据</summary><p>{question.frequency ? `F${question.frequency} 常见度：` : '常见度未标注：'}{question.frequencyBasis || '经验估计，非统计频率'}{question.frequencyScope && <><br />适用范围：{question.frequencyScope}</>}</p>{question.sourceRefs.length ? <ul>{question.sourceRefs.map((sourceRef, index) => <li key={index}>{/^https?:\/\//i.test(sourceRef.url) ? <a href={sourceRef.url} target="_blank" rel="noopener noreferrer">{sourceRef.label || sourceRef.url}</a> : <span>{sourceRef.label || sourceRef.url}</span>}</li>)}</ul> : <p className="muted">尚未添加参考资料。</p>}</details></section>
  </div>;
});

export const QuestionSetQuestionViewer = forwardRef<QuestionViewerHandle, { paperId: string; questionId: string }>(function QuestionSetQuestionViewer({ paperId, questionId }, ref) {
  const { data, loading, error, refresh } = useResource<QuestionSnapshot>(`/api/papers/${idPath(paperId)}/questions/${idPath(questionId)}`);
  if (loading) return <Loading text="正在读取题集中的题目…" />;
  if (error || !data) return <ErrorNotice message={error || '题集中的题目不存在'} retry={refresh} />;
  return <QuestionViewer ref={ref} question={data} />;
});
