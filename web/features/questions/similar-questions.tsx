import { useId, useState, type FormEvent } from 'react';
import { ExternalLink, Search, Sparkles, X } from 'lucide-react';
import type { Question } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import type { AiSimilarQuestionsResult, SimilarQuestionsResponse } from '../../../shared/models/similar-questions';
import { idPath, qs, useResource } from '../../shared/lib/api';
import { ActionDropdown } from '../../shared/ui/action-dropdown';
import { Empty, ErrorNotice, Field, Loading, Pagination, QuestionMeta, useApp } from '../../shared/ui/components';
import { QuestionContent } from '../../shared/ui/content-notices';
import { QuestionStructuredBody } from './question-structure';
import { AiRunHeading } from '../ai/ai-components';
import type { AiRunView } from '../ai/ai-api';
import { AiProgressPanel, aiFailureMessage, useAiProgress } from '../ai/ai-progress';
import './similar-questions.css';

export type SimilarQuestionsMode = 'search' | 'ai';

/** All reading surfaces use the same launcher and same in-page results. */
export function SimilarQuestionsLauncher({ onOpen, disabled = false, archived = false }: { onOpen: (mode: SimilarQuestionsMode) => void; disabled?: boolean; archived?: boolean }) {
  return <span title={archived ? '原题已归档，恢复发布或提交审核后可查找相似题' : undefined}><ActionDropdown label="查找相似题" icon={<Search size={16} />} disabled={disabled || archived} primaryAction={() => onOpen('search')} items={[
    { id: 'search-similar', label: '在题库查找相似题', icon: <Search size={16} />, onSelect: () => onOpen('search') },
    { id: 'ai-similar', label: 'AI推荐近似题', icon: <Sparkles size={16} />, onSelect: () => onOpen('ai') },
  ]} /></span>;
}

export function SimilarQuestionsPanel({ questionId, partId, initialMode = 'search', snapshotDifferent = false, onClose }: {
  questionId: string; partId?: string; initialMode?: SimilarQuestionsMode; snapshotDifferent?: boolean; onClose: () => void;
}) {
  const headingId = useId();
  const [mode, setMode] = useState(initialMode);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const [requirements, setRequirements] = useState('');
  const [run, setRun] = useState<AiRunView<AiSimilarQuestionsResult> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const progress = useAiProgress();
  const { bootstrap } = useApp();
  const result = useResource<SimilarQuestionsResponse>(mode === 'search' ? `/api/questions/${idPath(questionId)}/similar?${qs({ partId, q: query, page, pageSize })}` : null);
  const search = (event: FormEvent) => { event.preventDefault(); if (query !== input.trim()) { setRun(null); setError(''); } setQuery(input.trim()); setPage(1); if (query === input.trim() && page === 1) result.refresh(); };
  const recommend = async () => {
    setBusy(true); setError('');
    try { setRun(await progress.run<AiRunView<AiSimilarQuestionsResult>>('/api/ai/similar-questions', { confirmed: true, questionId, ...(partId ? { partId } : {}), ...(query ? { q: query } : {}), ...(requirements.trim() ? { requirements: requirements.trim() } : {}) })); }
    catch (reason) { setError(aiFailureMessage(reason)); }
    finally { setBusy(false); }
  };
  return <section className="card similar-questions" aria-labelledby={headingId}>
    <div className="similar-questions-heading"><div><h2 id={headingId}><Search size={18} />相似题与近似练习</h2><p className="muted">{partId ? '围绕当前小题' : '围绕当前题目'}查找题库中的已发布题目，展开预览即可比较。</p></div><button type="button" className="icon-button" aria-label="收起相似题" onClick={onClose}><X size={19} /></button></div>
    {snapshotDifferent && <p className="notice info">题集快照与当前原题不同，本次检索与 AI 推荐以当前原题为依据。</p>}
    <div className="section-tabs" role="tablist" aria-label="相似题查找方式">
      <button type="button" role="tab" disabled={busy} aria-selected={mode === 'search'} className={mode === 'search' ? 'selected' : ''} onClick={() => setMode('search')}><Search size={15} />题库搜索</button>
      <button type="button" role="tab" disabled={busy} aria-selected={mode === 'ai'} className={mode === 'ai' ? 'selected' : ''} onClick={() => setMode('ai')}><Sparkles size={15} />AI推荐近似题</button>
    </div>
    {mode === 'search' ? <div role="tabpanel" aria-label="题库搜索相似题">
      <form className="similar-questions-search" onSubmit={search}><Field label="相似题关键词（可选）" hint="留空时根据原题内容、分类与标签查找；最多8个搜索词，用空格分隔。"><input type="search" maxLength={100} value={input} onChange={event => setInput(event.target.value)} placeholder="例如：事务隔离、TCP重传" /></Field><button type="submit" className="button primary"><Search size={16} />查找</button></form>
      {result.loading ? <Loading text="正在题库查找相似题…" /> : result.error ? <ErrorNotice message={result.error} retry={result.refresh} /> : result.data && <>
        <p className="muted similar-questions-scope">{result.data.scope}</p>
        {result.data.items.length ? <div className="similar-questions-list">{result.data.items.map(item => <SimilarQuestionRow key={item.question.id} questionId={item.question.id} question={item.question} title={item.question.title} type={item.question.type} reason={item.reason} />)}</div> : <Empty title="暂未找到相似题" description="可以换一组关键词，或使用 AI 从题库候选中推荐近似练习。" />}
        <Pagination page={page} pageSize={pageSize} total={result.data.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="相似题" />
      </>}
    </div> : <div role="tabpanel" aria-label="AI推荐近似题">
      <p className="muted">运行时会把当前原题与有限的题库候选内容发送给已配置模型。AI 仅推荐已有题目，并说明相似考点；推荐理由仍需核对。</p>
      {query && <p className="notice info">本次候选范围使用已查找关键词：{query}。可返回题库搜索调整。</p>}
      {bootstrap.ai.available ? null : <div className="notice info">AI辅助尚未开启，请先在<a href="#/settings?tab=ai" target="_blank" rel="noopener noreferrer">系统配置</a>中配置模型服务。</div>}
      <Field label="近似题推荐要求（可选）"><textarea rows={3} maxLength={2000} disabled={busy} value={requirements} onChange={event => setRequirements(event.target.value)} placeholder="例如：推荐同一考点、不同问法的题目；优先基础客观题。" /></Field>
      <div className="similar-questions-ai-actions"><button type="button" className="button primary" disabled={busy || !bootstrap.ai.available} onClick={() => void recommend()}><Sparkles size={16} />{busy ? '正在推荐…' : run ? '重新 AI 推荐' : '开始 AI 推荐'}</button><a className="button" href={`#/ai?tab=history&${qs({ kind: 'similar_questions', questionId, ...(run ? { run: run.id } : {}) })}`} target="_blank" rel="noopener noreferrer">查看 AI 处理记录<ExternalLink size={14} /></a></div>
      {(busy || run || error || progress.progress.status === 'cancelled') && <AiProgressPanel value={progress.progress} cancel={progress.cancel} previousResult={!!run} />}
      {error && <ErrorNotice message={error} />}
      {run && <div className="similar-questions-ai-result"><AiRunHeading run={run} title="AI近似题推荐" /><p className="muted">{run.result.scope}</p>{run.result.items.length ? <div className="similar-questions-list">{run.result.items.map(item => { const candidate = run.result.candidates.find(value => value.id === item.questionId); return <SimilarQuestionRow key={item.questionId} questionId={item.questionId} title={candidate?.title || item.questionId} type={candidate?.type} reason={item.reason} />; })}</div> : <Empty title="未推荐合适的近似题" description="本轮未找到足够相关的候选，可调整要求或使用题库搜索。" />}</div>}
    </div>}
  </section>;
}

function SimilarQuestionRow({ questionId, question, title, type, reason }: { questionId: string; question?: Question; title: string; type?: string; reason: string }) {
  const [open, setOpen] = useState(false);
  const resource = useResource<Question>(open && !question ? `/api/questions/${idPath(questionId)}` : null);
  const value = question || resource.data;
  const answers = (values: string[]) => values.length ? <p><strong>正确答案：</strong>{values.map(answer => answer === 'true' ? '对' : answer === 'false' ? '错' : answer).join('、')}</p> : null;
  return <article className="similar-question-row">
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary><span className="similar-question-title">{title}</span>{type && <span className="type-badge">{typeLabels[type as Question['type']] || type}</span>}<span className="similar-question-preview-label">展开预览</span></summary>
      <p className="similar-question-reason">{reason}</p>
      {open && (!question && resource.loading ? <Loading text="正在读取题目预览…" /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : value ? <div className="similar-question-preview">
        <QuestionMeta question={value} compact /><QuestionContent questionType={value.type}>{value.stemMarkdown}</QuestionContent><QuestionStructuredBody question={value} />
        {value.options.map(option => <div className="similar-question-option" key={option.key}><strong>{option.key}</strong><QuestionContent>{option.text}</QuestionContent></div>)}
        <details className="similar-question-answer"><summary>查看答案与解析</summary>{answers(value.correctAnswers)}<QuestionStructuredBody question={value} showAnswers /><QuestionContent>{value.answerMarkdown}</QuestionContent><QuestionContent>{value.explanationMarkdown}</QuestionContent></details>
        <a className="button" href={`#/questions/${idPath(questionId)}`} target="_blank" rel="noopener noreferrer">在题库中查看<ExternalLink size={14} /></a>
      </div> : null)}
    </details>
    <p className="similar-question-reason">{reason}</p>
  </article>;
}
