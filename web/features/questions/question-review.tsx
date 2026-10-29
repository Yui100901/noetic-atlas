import {QuestionContent, SourceNoticeScope, questionNoticeContents} from '../../shared/ui/content-notices';
import { useEffect, useState, type ChangeEvent } from 'react';
import { ArrowLeft, Check, Download, Edit3, Plus, RotateCcw, Upload } from 'lucide-react';
import type { PendingQuestionExport, Question, QuestionPage, QuestionReviewInput } from '../../../shared/models/types';
import { localDate, qs, send, useDebounced, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, QuestionMeta, SearchBox, useApp } from '../../shared/ui/components';
import { QuestionStructuredBody } from './question-structure';
import { saveGeneratedFile } from '@platform';
import '../../shared/ui/review-taxonomy.css';
import { AiReviewButton } from '../ai/ai-components';
import {usePagination} from '../../shared/lib/pagination';
import { managementEditorHref, managementLocation, readManagementLocation } from './management-navigation';

export function QuestionReviewPage() {
  const { bootstrap, reload, toast } = useApp();
  const [initialLocation] = useState(() => readManagementLocation(window.location.hash));
  const [search, setSearch] = useState(initialLocation?.search||''); const [domainId, setDomainId] = useState(initialLocation?.domainId||''); const [page, setPage] = useState(initialLocation?.page||1); const [pageSize,setPageSize]=useState(initialLocation?.pageSize||20);
  const returnTo=managementLocation('review',{search,domainId,page,pageSize});
  useEffect(()=>{if(window.location.hash!==returnTo)history.replaceState(history.state,'',returnTo);},[returnTo]);
  const debounced = useDebounced(search), waiting = debounced !== search;
  const listUrl = `/api/questions?${qs({ status: 'pending', search: debounced, domainId, page, pageSize })}`;
  const resource = useResource<QuestionPage>(waiting ? null : listUrl);
  // A pending query must never lend its previous page to selection or review.
  const current = !waiting && resource.dataUrl === listUrl;
  const data = current ? resource.data : null;
  const loading = waiting || resource.loading || !current && !resource.error;
  const listError = waiting ? '' : resource.error;
  const [selected, setSelected] = useState<Record<string, Question>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [incoming, setIncoming] = useState<PendingQuestionExport | null>(null); const [fileName, setFileName] = useState('');
  const previewPaging=usePagination(incoming?.questions||[],fileName);
  const ids = Object.keys(selected), items = !loading && !listError ? data?.items || [] : [];
  const selectedHere = items.filter(question => selected[question.id]).length;
  const selectionScope = `领域：${bootstrap.domains.find(domain => domain.id === domainId)?.name || '所有领域'}${search.trim() ? `；关键词：${search.trim()}` : ''}`;
  const selectionBlocked = busy || loading || !!listError;
  useEffect(() => {
    if (!data || loading) return;
    const maximum = Math.max(1, Math.ceil(data.total / pageSize));
    if (page > maximum) setPage(maximum);
  }, [data, loading, page, pageSize]);
  const toggle = (q: Question) => { if (selectionBlocked) return; setSelected(old => { const next = { ...old }; if (next[q.id]) delete next[q.id]; else if (Object.keys(next).length < 500) next[q.id] = q; return next; }); };
  const refresh = () => { resource.refresh(); reload(); setSelected({}); setPage(1); };
  const review = async (action: QuestionReviewInput['action']) => {
    if (selectionBlocked || !ids.length || !confirm(action === 'approve' ? `${selectionScope}。确认已检查这 ${ids.length} 道题的题干、答案、解析和归类，并将它们加入正式题库？` : `${selectionScope}。将这 ${ids.length} 道题退回草稿，等待修改后重新提交？`)) return;
    setBusy(true); setError('');
    try {
      await send('/api/questions/review', 'POST', { ids, action, confirmed: true, expectedUpdatedAt: Object.fromEntries(ids.map(id => [id, selected[id].updatedAt])) });
      toast(action === 'approve' ? `已审核通过 ${ids.length} 道题` : `已退回 ${ids.length} 道草稿`); refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const exportJson = async () => {
    if (selectionBlocked || !ids.length) return;
    setBusy(true); setError('');
    try { const data = await send<PendingQuestionExport>('/api/questions/pending/export', 'POST', { ids }); await saveGeneratedFile(`待审核题目-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'application/json'); toast('待审核 JSON 已导出'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const loadJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; setIncoming(null); setFileName(''); setError(''); if (!file) return;
    try {
      if (file.size > 75 * 1024 * 1024) throw new Error('文件超过75 MiB，请拆分为较小批次。');
      const data = JSON.parse(await file.text());
      if (data?.format !== 'learning-pending-questions' || data?.schemaVersion !== 1 || !Array.isArray(data.questions) || !data.questions.length || data.questions.length > 500) throw new Error('请选择本页导出的待审核 JSON，单批1—500题。');
      if (data.questions.some((q: Question) => !q.id || q.status !== 'pending' || !q.updatedAt)) throw new Error('题号、pending状态和updatedAt版本必须保留。');
      setIncoming(data); setFileName(file.name);
    } catch (err) { setError((err as Error).message); }
  };
  const importJson = async () => {
    if (!incoming || !confirm(`确认用文件内容更新 ${incoming.questions.length} 道现有待审核题？全部验证成功才保存；导入后仍需审核。`)) return;
    setBusy(true); setError('');
    try { const result = await send<{ updated: number }>('/api/questions/pending/import', 'POST', { data: incoming, confirmed: true }); toast(`已更新 ${result.updated} 道待审核题，尚未发布`); setIncoming(null); setFileName(''); refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <><a className="back-link" href="#/questions"><ArrowLeft size={15} />返回正式题库</a><PageHeader eyebrow="QUESTION REVIEW" title="审核管理" description="确认题目能否进入正式题库。新题先进入待审核区，检查题干、答案、解析和归类后由你确认发布。" actions={<><a className="button" href="#/questions/import">批量新增</a><a className="button primary" href={`#/questions/new?returnTo=${encodeURIComponent(returnTo)}`}><Plus size={16} />新建题目</a></>} />
    <div className="review-filters"><SearchBox value={search} onChange={value => { setSearch(value); setPage(1); setSelected({}); }} placeholder="搜索待审核题目" /><select aria-label="审核题目领域" value={domainId} onChange={e => { setDomainId(e.target.value); setPage(1); setSelected({}); }}><option value="">所有领域</option>{bootstrap.domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><button className="button" onClick={() => { setError(''); refresh(); }} disabled={busy}><RotateCcw size={15} />刷新</button></div>
    <section className="card review-batch"><div><strong>已选择 {ids.length} 题</strong><p className="muted">可跨页选择，人工审核单批最多500题，AI审核每批最多20题。审核会核对版本，避免覆盖刚发生的修改。</p><p className="muted" aria-label="审核选择范围">{selectionScope} · 本页已选 {selectedHere} 题，其他页已选 {ids.length - selectedHere} 题</p>{ids.length > 0 && <details><summary>查看已选题目（{ids.length}题）</summary><ul className="review-selection-list">{Object.values(selected).map(question => <li key={question.id}>{question.id} · {question.title}</li>)}</ul></details>}</div><div className="review-actions"><AiReviewButton questions={selectionBlocked ? [] : Object.values(selected)} onUpdated={refresh} /><button className="button" disabled={selectionBlocked || !items.length} onClick={() => setSelected(old => Object.fromEntries([...Object.entries(old), ...items.map(q => [q.id, q] as const)].slice(0, 500)))}>全选本页</button><button className="text-button" disabled={busy || !ids.length} onClick={() => setSelected({})}>清空选择</button><button className="button" disabled={selectionBlocked || !ids.length} onClick={() => void exportJson()}><Download size={15} />导出待审核 JSON</button><button className="button" disabled={selectionBlocked || !ids.length} onClick={() => void review('return_to_draft')}>退回草稿</button><button className="button primary" disabled={selectionBlocked || !ids.length} onClick={() => void review('approve')}><Check size={16} />确认批量通过</button></div></section>
    {error && <ErrorNotice message={error} />}<div className="result-heading"><span>{loading ? '正在读取…' : `${data?.total || 0} 道待审核题目`}</span><span className="muted">发布前请核对参考来源与答案</span></div>
    {loading ? <Loading /> : listError ? <ErrorNotice message={listError} retry={resource.refresh} /> : !items.length ? <Empty title="当前没有待审核题目" description="新建题目保存为待审核后，会出现在这里。" /> : <><div className="review-list">{items.map(q => <article className={`card review-item ${selected[q.id] ? 'is-selected' : ''}`} key={q.id}><div className="review-item-heading"><input aria-label={`审核选择 ${q.id}`} type="checkbox" disabled={busy || !selected[q.id] && ids.length >= 500} checked={!!selected[q.id]} onChange={() => toggle(q)} /><div><QuestionMeta question={q} /><h2><a href={managementEditorHref(q.id,returnTo)}>{q.title}</a></h2><p className="muted">更新于 {localDate(q.updatedAt)}</p></div><a className="button" href={managementEditorHref(q.id,returnTo)}><Edit3 size={14} />详情与编辑</a></div><details open><summary>核对题干、选项与答案解析</summary><SourceNoticeScope contents={questionNoticeContents(q)}><div className="review-preview"><QuestionContent questionType={q.type}>{q.stemMarkdown}</QuestionContent>{q.options.map(o => <div key={o.key}><strong>{o.key}</strong><QuestionContent>{o.text}</QuestionContent></div>)}<QuestionStructuredBody question={q} showAnswers /><h3>参考答案 {q.correctAnswers.map(a => a === 'true' ? '正确' : a === 'false' ? '错误' : a).join('、')}</h3><QuestionContent>{q.answerMarkdown}</QuestionContent><h3>解析与追问</h3><QuestionContent>{q.explanationMarkdown}</QuestionContent></div></SourceNoticeScope></details></article>)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={data?.total || 0} onPage={setPage} /></>}
    <section className="card pending-import"><h2><Upload size={18} />在外部批量修改，再导回待审核区</h2><p>导出 JSON 后可修改题干、选项、答案、解析与归类。保留题号、pending状态及原updatedAt。导入只更新现有待审核题，不会新增或发布题目；任何一题冲突则整批不保存。</p><label className="button pending-file-picker"><Upload size={15} />选择修改后的 JSON<input aria-label="待审核 JSON 文件" type="file" accept=".json,application/json" disabled={busy} onChange={e => void loadJson(e)} /></label>{incoming && <div className="pending-import-preview"><strong>{fileName} · {incoming.questions.length} 题</strong><ul>{previewPaging.items.map(q => <li key={q.id}>{q.id} · {q.title}</li>)}</ul><Pagination {...previewPaging} label="待审修改预览"/><div className="review-actions"><button className="button primary" disabled={busy} onClick={() => void importJson()}>确认更新待审核题目</button><button className="button" disabled={busy} onClick={() => setIncoming(null)}>取消</button></div></div>}</section>
  </>;
}
