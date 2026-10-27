import { useEffect, useRef, useState } from 'react';
import { FileInput, FolderOpen, RefreshCw, Save, Square } from 'lucide-react';
import { AI_DOCUMENT_LIMITS, type AiDocumentJob, type AiDocumentJobSummary } from '../../../shared/ai/ai-document';
import { typeLabels, type QuestionType } from '../../../shared/models/types';
import type { Paged } from '../../../shared/utils/pagination';
import { idPath, localDate, request, send, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, MultiSelect, Pagination, useApp } from '../../shared/ui/components';
import { TagPicker } from '../../shared/ui/tag-picker';
import { AiServiceNotice } from './ai-components';
import { extractDocumentFiles, type DocumentExtractProgress, type DocumentFilesResult } from './ai-document-files';
import { AiDocumentJobPanel } from './ai-document-job';
import { AiDocumentSourcePreview } from './ai-document-source-preview';
import { aiFailureMessage } from './ai-progress';
import './ai-document.css';

export const documentStatusLabels: Record<string, string> = { pending: '待分析', running: '处理中', ready: '可选择知识块', partial: '部分完成／有失败', failed: '处理失败', completed: '已生成预览' };

export function AiDocumentWorkspace() {
  const { bootstrap, toast } = useApp();
  const input = useRef<HTMLInputElement>(null), extraction = useRef<AbortController | null>(null);
  const [local, setLocal] = useState<DocumentFilesResult | null>(null), [extractProgress, setExtractProgress] = useState<DocumentExtractProgress | null>(null);
  const [sourceName, setSourceName] = useState(''), [sourceUrl, setSourceUrl] = useState(''), [requirements, setRequirements] = useState('');
  const [first, setFirst] = useState(''), [last, setLast] = useState(''), [perBlock, setPerBlock] = useState(10), [maximum, setMaximum] = useState(200);
  const [mode, setMode] = useState<'generate' | 'extract'>('generate'), [types, setTypes] = useState<string[]>([]), [difficulty, setDifficulty] = useState('');
  const [categoryIds, setCategoryIds] = useState<string[]>([]), [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [job, setJob] = useState<AiDocumentJob | null>(null);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const jobs = useResource<Paged<AiDocumentJobSummary>>(`/api/ai/document-jobs?page=${page}&pageSize=${pageSize}`);
  const domains = Array.from(new Set(categoryIds.map(id => bootstrap.categories.find(category => category.id === id)?.domainId).filter(Boolean))) as string[];
  const open = async (id: string) => { setError(''); setBusy(true); try { setJob(await request<AiDocumentJob>(`/api/ai/document-jobs/${idPath(id)}`)); } catch (reason) { setError(aiFailureMessage(reason)); } finally { setBusy(false); } };
  useEffect(() => {
    const id = new URLSearchParams(window.location.hash.split('?')[1] || '').get('job'); if (id) void open(id);
    return () => extraction.current?.abort();
  }, []);
  const extract = async (files: File[]) => {
    if (!files.length) return;
    const controller = new AbortController(); extraction.current?.abort(); extraction.current = controller;
    setBusy(true); setError(''); setLocal(null); setExtractProgress(null);
    try {
      const value = await extractDocumentFiles(files, { ...(first ? { firstPage: Number(first) } : {}), ...(last ? { lastPage: Number(last) } : {}), signal: controller.signal, onProgress: setExtractProgress });
      if (!controller.signal.aborted) { setLocal(value); setSourceName(value.sourceName); setMaximum(Math.min(AI_DOCUMENT_LIMITS.maxQuestionsPerJob, Math.max(200, value.sections.length * perBlock))); }
    } catch (reason) { if (!controller.signal.aborted) setError(aiFailureMessage(reason)); }
    finally { if (extraction.current === controller) { setBusy(false); setExtractProgress(null); extraction.current = null; } }
  };
  const create = async () => {
    if (!local || !sourceName.trim()) return;
    if (!confirm('创建可恢复的教材任务后，提取的正文会保存到本机数据库，供分块、失败重试和再次打开使用。现在不会发送模型或新增题目，是否继续？')) return;
    setBusy(true); setError('');
    try {
      const value = await send<AiDocumentJob>('/api/ai/document-jobs', 'POST', { confirmed: true, sourceName: sourceName.trim(), ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}), sections: local.sections, mode, requirements, questionTypes: types, ...(difficulty ? { difficulty: Number(difficulty) } : {}), categoryIds, tagIds, questionsPerBlock: perBlock, maxQuestions: maximum });
      setJob(value); setLocal(null); jobs.refresh(); toast('教材任务已保存在本机，可先分析知识块再选择出题');
    } catch (reason) { setError(aiFailureMessage(reason)); } finally { setBusy(false); }
  };
  return <div className="ai-document-workspace form-stack">
    <section className="card ai-tools form-stack">
      <div className="list-toolbar"><div><h2>1. 读取多份资料或整本教材</h2><p className="muted">先在本机分块，再逐轮总结。选择需要的知识块后生成练习，成功批次保留，失败批次可单独重试。</p></div><button className="button" disabled={busy} onClick={() => input.current?.click()}><FileInput size={16} />选择多个 PDF / 文本文件</button></div>
      <input ref={input} type="file" multiple className="sr-only" aria-label="AI分批原始文件" accept=".pdf,.txt,.md,.markdown,.json,.csv" disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void extract(files); }} />
      <AiServiceNotice />
      <div className="form-grid"><Field label="PDF起始页（可选）" hint="文件中的页码，从1开始；留空从首页。"><input type="number" min="1" value={first} disabled={busy} onChange={event => setFirst(event.target.value)} /></Field><Field label="PDF结束页（可选）" hint="留空到末页；范围用于本次选择的每份PDF。"><input type="number" min="1" value={last} disabled={busy} onChange={event => setLast(event.target.value)} /></Field></div>
      <p className="muted">每次最多20份文件，单文件30MiB，PDF最多2000页；提取正文总计不超过400万字符／12MB／600块。不含OCR，扫描图、复杂公式和多栏内容需先识别或校对。</p>
      {extractProgress && <div className="notice info" role="status"><span>正在本机读取 {extractProgress.file}/{extractProgress.totalFiles}：{extractProgress.filename}{extractProgress.page ? ` · 第${extractProgress.page}/${extractProgress.totalPages}页` : ''}</span><button className="button" onClick={() => extraction.current?.abort()}><Square size={14} />停止提取</button></div>}
      {local && <>
        <div className="notice info">已读取{local.files}份资料{local.pages ? `、${local.pages}页PDF` : ''}，共{local.characters.toLocaleString()}字符，整理为{local.sections.length}个初始块。尚未请求模型。</div>
        {local.warnings.map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
        <AiDocumentSourcePreview sections={local.sections} />
        <Field label="教材任务名称"><input value={sourceName} maxLength={300} disabled={busy} onChange={event => setSourceName(event.target.value)} /></Field>
        <Field label="教材出处链接（可选）" hint="仅作为出处保存，不自动下载。"><input type="url" value={sourceUrl} maxLength={3000} disabled={busy} onChange={event => setSourceUrl(event.target.value)} /></Field>
        <div className="form-grid"><Field label="分批处理方式"><select value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'generate' | 'extract')}><option value="generate">教材知识出题</option><option value="extract">整理已有题目</option></select></Field><Field label="每块最多题量"><input type="number" min="1" max="50" value={perBlock} disabled={busy} onChange={event => setPerBlock(Number(event.target.value))} /></Field><Field label="整个任务最多题量"><input type="number" min="1" max={AI_DOCUMENT_LIMITS.maxQuestionsPerJob} value={maximum} disabled={busy} onChange={event => setMaximum(Number(event.target.value))} /></Field><Field label="分批题目难度"><select value={difficulty} disabled={busy} onChange={event => setDifficulty(event.target.value)}><option value="">按材料判断</option>{[1, 2, 3, 4].map(value => <option key={value} value={value}>D{value}</option>)}</select></Field></div>
        <p className="muted">选择全部初始块时，题量预算约需{local.sections.length * perBlock}题；也可以总结后只选择部分知识块。任务创建后配置固定，便于失败重试和结果核对。</p>
        <Field label="分批出题要求"><textarea rows={3} maxLength={5000} value={requirements} disabled={busy} onChange={event => setRequirements(event.target.value)} placeholder="例如：按章节提炼核心概念，用中文生成判断、选择和简答，解析说明依据。" /></Field>
        <MultiSelect label="分批题型范围" options={Object.entries(typeLabels).map(([id, name]) => ({ id: id as QuestionType, name }))} values={types} onChange={setTypes} />
        <MultiSelect label="分批目标分类" options={bootstrap.categories.map(category => ({ id: category.id, name: `${bootstrap.domains.find(domain => domain.id === category.domainId)?.name || ''} / ${category.name}` }))} values={categoryIds} onChange={setCategoryIds} />
        <TagPicker tags={bootstrap.tags} domains={bootstrap.domains} domainIds={domains.length ? domains : undefined} values={tagIds} onChange={setTagIds} />
        <button className="button primary" disabled={busy || !sourceName.trim() || perBlock < 1 || perBlock > 50 || maximum < 1 || maximum > AI_DOCUMENT_LIMITS.maxQuestionsPerJob} onClick={() => void create()}><Save size={16} />创建可恢复教材任务</button>
      </>}
      {error && <ErrorNotice message={error} />}
    </section>
    {job && <AiDocumentJobPanel key={job.id} job={job} onChange={setJob} onSettled={jobs.refresh} onClose={() => { setJob(null); jobs.refresh(); }} />}
    <section className="card form-stack ai-tools"><div className="list-toolbar"><h2>已保存的教材任务</h2><button className="button" onClick={jobs.refresh}><RefreshCw size={15} />刷新任务</button></div>
      {jobs.loading ? <Loading /> : jobs.error ? <ErrorNotice message={jobs.error} retry={jobs.refresh} /> : jobs.data?.items.length ? <div className="ai-document-jobs">{jobs.data.items.map(item => <article key={item.id}><div><strong>{item.sourceName}</strong><span className={`badge ai-run-status-${item.status}`}>{documentStatusLabels[item.status] || item.status}</span><p className="muted">{localDate(item.updatedAt)} · 已总结{item.plannedBlocks}/{item.blockCount}块 · 已生成{item.questionCount}题 · 已导入{item.importedCount}题{item.failedBlocks ? ` · ${item.failedBlocks}块失败` : ''}</p></div><button className="button" disabled={busy} onClick={() => void open(item.id)}><FolderOpen size={15} />打开并继续</button></article>)}</div> : <Empty title="还没有分批教材任务" description="创建任务后可离开页面，回来继续选择知识块、重试失败或确认导入。" />}
      <Pagination page={page} pageSize={pageSize} total={jobs.data?.total || 0} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="教材任务" />
    </section>
  </div>;
}
