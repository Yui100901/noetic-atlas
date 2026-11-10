import {QuestionContent, SourceNoticeScope, questionNoticeContents} from '../../shared/ui/content-notices';
import { replaceCurrentHashLocation } from '../../shared/lib/route-location';
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, Edit3, Plus, RotateCcw } from 'lucide-react';
import type { Question, QuestionPage, QuestionReviewInput } from '../../../shared/models/types';
import { localDate, qs, send, useDebounced, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, QuestionMeta, SearchBox, useApp } from '../../shared/ui/components';
import { QuestionStructuredBody } from './question-structure';
import { exportPackage } from '../../shared/lib/data-package';
import { DataPackageEditor } from '../../shared/ui/data-package-editor';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import '../../shared/ui/review-taxonomy.css';
import { AiReviewButton } from '../ai/ai-components';
import { managementEditorHref, managementLocation, readManagementLocation } from './management-navigation';

export function QuestionReviewPage() {
  const { bootstrap, reload, toast } = useApp();
  const [initialLocation] = useState(() => readManagementLocation(window.location.hash));
  const [search, setSearch] = useState(initialLocation?.search||''); const [domainId, setDomainId] = useState(initialLocation?.domainId||''); const [page, setPage] = useState(initialLocation?.page||1); const [pageSize,setPageSize]=useState(initialLocation?.pageSize||20);
  const returnTo=managementLocation('review',{search,domainId,page,pageSize});
  useEffect(()=>{replaceCurrentHashLocation(returnTo);},[returnTo]);
  const debounced = useDebounced(search), waiting = debounced !== search;
  const listUrl = `/api/questions?${qs({ status: 'pending', search: debounced, domainId, page, pageSize })}`;
  const resource = useResource<QuestionPage>(waiting ? null : listUrl);
  // A pending query must never lend its previous page to selection or review.
  const current = !waiting && resource.dataUrl === listUrl;
  const data = current ? resource.data : null;
  const loading = waiting || resource.loading || !current && !resource.error;
  const listError = waiting ? '' : resource.error;
  const [selected, setSelected] = useState<Record<string, Question>>({});
  const [preparedFile, setPreparedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
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
  const exportUpdatePackage = async () => {
    if (selectionBlocked || !ids.length) return;
    setBusy(true); setError('');
    try { await exportPackage({ kind: 'question-update', ids }); toast('待审核修改数据包已导出'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <><a className="back-link" href="#/questions"><ArrowLeft size={15} />返回正式题库</a><PageHeader eyebrow="QUESTION REVIEW" title="审核管理" description="确认题目能否进入正式题库。新题先进入待审核区，检查题干、答案、解析和归类后由你确认发布。" actions={<><a className="button" href="#/sharing?tab=template">批量新增</a><a className="button primary" href={`#/questions/new?returnTo=${encodeURIComponent(returnTo)}`}><Plus size={16} />新建题目</a></>} />
    <div className="review-filters"><SearchBox value={search} onChange={value => { setSearch(value); setPage(1); setSelected({}); }} placeholder="搜索待审核题目" /><select aria-label="审核题目领域" value={domainId} onChange={e => { setDomainId(e.target.value); setPage(1); setSelected({}); }}><option value="">所有领域</option>{bootstrap.domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><button className="button" onClick={() => { setError(''); refresh(); }} disabled={busy}><RotateCcw size={15} />刷新</button></div>
    <section className="card review-batch"><div><strong>已选择 {ids.length} 题</strong><p className="muted">可跨页选择，人工审核单批最多500题，AI审核每批最多20题。审核会核对版本，避免覆盖刚发生的修改。</p><p className="muted" aria-label="审核选择范围">{selectionScope} · 本页已选 {selectedHere} 题，其他页已选 {ids.length - selectedHere} 题</p>{ids.length > 0 && <details><summary>查看已选题目（{ids.length}题）</summary><ul className="review-selection-list">{Object.values(selected).map(question => <li key={question.id}>{question.id} · {question.title}</li>)}</ul></details>}</div><div className="review-actions"><AiReviewButton questions={selectionBlocked ? [] : Object.values(selected)} onUpdated={refresh} /><button className="button" disabled={selectionBlocked || !items.length} onClick={() => setSelected(old => Object.fromEntries([...Object.entries(old), ...items.map(q => [q.id, q] as const)].slice(0, 500)))}>全选本页</button><button className="text-button" disabled={busy || !ids.length} onClick={() => setSelected({})}>清空选择</button><button className="button" disabled={selectionBlocked || !ids.length} onClick={() => void exportUpdatePackage()}><Download size={15} />导出待审修改包（ZIP）</button><button className="button" disabled={selectionBlocked || !ids.length} onClick={() => void review('return_to_draft')}>退回草稿</button><button className="button primary" disabled={selectionBlocked || !ids.length} onClick={() => void review('approve')}><Check size={16} />确认批量通过</button></div></section>
    {error && <ErrorNotice message={error} />}<div className="result-heading"><span>{loading ? '正在读取…' : `${data?.total || 0} 道待审核题目`}</span><span className="muted">发布前请核对参考来源与答案</span></div>
    {loading ? <Loading /> : listError ? <ErrorNotice message={listError} retry={resource.refresh} /> : !items.length ? <Empty title="当前没有待审核题目" description="新建题目保存为待审核后，会出现在这里。" /> : <><div className="review-list">{items.map(q => <article className={`card review-item ${selected[q.id] ? 'is-selected' : ''}`} key={q.id}><div className="review-item-heading"><input aria-label={`审核选择 ${q.id}`} type="checkbox" disabled={busy || !selected[q.id] && ids.length >= 500} checked={!!selected[q.id]} onChange={() => toggle(q)} /><div><QuestionMeta question={q} /><h2><a href={managementEditorHref(q.id,returnTo)}>{q.title}</a></h2><p className="muted">更新于 {localDate(q.updatedAt)}</p></div><a className="button" href={managementEditorHref(q.id,returnTo)}><Edit3 size={14} />详情与编辑</a></div><details open><summary>核对题干、选项与答案解析</summary><SourceNoticeScope contents={questionNoticeContents(q)}><div className="review-preview"><QuestionContent questionType={q.type}>{q.stemMarkdown}</QuestionContent>{q.options.map(o => <div key={o.key}><strong>{o.key}</strong><QuestionContent>{o.text}</QuestionContent></div>)}<QuestionStructuredBody question={q} showAnswers /><h3>参考答案 {q.correctAnswers.map(a => a === 'true' ? '正确' : a === 'false' ? '错误' : a).join('、')}</h3><QuestionContent>{q.answerMarkdown}</QuestionContent><h3>解析与追问</h3><QuestionContent>{q.explanationMarkdown}</QuestionContent></div></SourceNoticeScope></details></article>)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={data?.total || 0} onPage={setPage} /></>}
    <div className="ui-stack"><DataPackageEditor kind="question-update" onPrepared={setPreparedFile}/><DataPackageImport preparedFile={preparedFile} title="导入待审核修改数据包" description="上传修改后的完整ZIP包。系统读取manifest并核对全部文件及题目版本，只更新现有待审核题，不会直接发布；任何冲突使整包回滚。" onImported={refresh} /></div>
  </>;
}
