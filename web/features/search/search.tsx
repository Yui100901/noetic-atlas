import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ClipboardList, FileText, FolderTree, Globe2, LibraryBig, Search, StickyNote, Tag, X } from 'lucide-react';
import type { SearchItem, SearchResponse, SearchType } from '../../../shared/models/search';
import { qs, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, PageHeader, Pagination, useApp } from '../../shared/ui/components';
import { readSearchState, searchHighlights, searchHref, searchInputError, searchResultHref, searchReturnTarget, searchTypeLabels, searchTypes, type SearchState } from './search-navigation';
import './search.css';

const icons = { question: LibraryBig, paper: ClipboardList, document: FileText, note: StickyNote, domain: Globe2, category: FolderTree, tag: Tag };
const statusLabels: Record<string, string> = { published: '已发布', pending: '待审核', draft: '草稿', archived: '已归档' };
const isExamActive = () => document.body.classList.contains('exam-active');
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');

export function UnifiedSearchBar({ hash }: { hash: string }) {
  const [value, setValue] = useState(() => /^#\/search(?:\?|$)/.test(hash) ? readSearchState(hash).q : '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (/^#\/search(?:\?|$)/.test(hash)) setValue(readSearchState(hash).q); }, [hash]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.activeElement === input.current) { input.current?.blur(); return; }
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || isExamActive()) return;
      if (editable(event.target) && event.target !== input.current) return;
      event.preventDefault(); input.current?.focus(); input.current?.select();
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  return <form className="top-search unified-top-search" role="search" aria-label="全站统一搜索" onSubmit={event => {
    event.preventDefault(); if (isExamActive()) return;
    const current = readSearchState('#/search'); window.location.hash = searchHref({ ...current, q: value }); input.current?.blur();
  }}><Search size={15} aria-hidden="true" /><input ref={input} aria-label="全站搜索" type="search" maxLength={100} value={value} onChange={event => setValue(event.target.value)} placeholder="搜索全部内容…" autoComplete="off" /><kbd aria-hidden="true">Ctrl K</kbd><button aria-label="执行统一搜索" title="搜索全部内容" type="submit"><ArrowRight size={16} /></button></form>;
}

export function SearchReturnLink({ hash }: { hash: string }) {
  const target = searchReturnTarget(hash);
  return target ? <a className="button feature-entry search-return-link" href={target}><ArrowLeft size={15} />返回搜索结果</a> : null;
}

function Highlight({ text, query }: { text: string; query: string }) {
  return <>{searchHighlights(text, query).map((part, index) => part.matched ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}

function SearchResult({ item, state }: { item: SearchItem; state: SearchState }) {
  const { bootstrap } = useApp(), Icon = icons[item.type], target = searchResultHref(item.href, state);
  const domains = item.domainIds.map(id => bootstrap.domains.find(domain => domain.id === id)?.name).filter(Boolean);
  return <li className={`unified-result result-${item.type}`}>
    <span className="unified-result-icon"><Icon size={20} aria-hidden="true" /></span>
    <div className="unified-result-content"><div className="unified-result-meta"><span className="badge">{searchTypeLabels[item.type]}</span>{item.status && item.status !== 'published' && <span className={`badge search-status-${item.status}`}>{statusLabels[item.status] || item.status}</span>}{domains.length > 0 && <span>{domains.join(' · ')}</span>}{item.updatedAt && <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</time>}</div>
      <h2>{target ? <a href={target}><Highlight text={item.title || item.id} query={state.q} /></a> : <Highlight text={item.title || item.id} query={state.q} />}</h2>
      {item.description && <p className="unified-result-description"><Highlight text={item.description} query={state.q} /></p>}
      {item.excerpt && <p className="unified-result-excerpt"><Highlight text={item.excerpt} query={state.q} /></p>}
      <div className="unified-result-footer"><code title={item.id}><Highlight text={item.id} query={state.q} /></code>{item.matchIn === 'reference' && <span className="search-reference-note">匹配参考答案或解析，打开后查看</span>}{item.partId && <span>组合小题笔记</span>}{target && <a className="unified-result-open" href={target} aria-label={`打开${searchTypeLabels[item.type]}：${item.title || item.id}`}>打开<ArrowRight size={14} /></a>}</div>
    </div>
  </li>;
}

export function UnifiedSearchPage({ hash }: { hash: string }) {
  const state = readSearchState(hash), [draft, setDraft] = useState(state.q), [inputError, setInputError] = useState('');
  const validation = searchInputError(state.q), hasQuery = !!state.q.trim();
  const result = useResource<SearchResponse>(hasQuery && !validation ? `/api/search?${qs({ ...state })}` : null);
  const update = (change: Partial<SearchState>) => { window.location.hash = searchHref({ ...state, ...change }); };
  const submit = () => { const error = searchInputError(draft); setInputError(error); if (!error) update({ q: draft.trim(), page: 1 }); };
  const counts = result.data?.counts;
  return <div className="unified-search-page"><PageHeader eyebrow="SEARCH YOUR KNOWLEDGE" title="让相关的知识，一起出现。" description="统一查找题目、题集、学习资料、笔记及知识归类。" />
    <form className="card unified-search-form" role="search" aria-label="搜索内容" onSubmit={event => { event.preventDefault(); submit(); }}><label className="unified-search-input"><Search size={20} aria-hidden="true" /><span className="sr-only">搜索关键词</span><input type="search" maxLength={100} value={draft} onChange={event => { setDraft(event.target.value); setInputError(''); }} placeholder="输入关键词或题号，空格分隔多个词" autoComplete="off" />{draft && <button type="button" className="icon-button" aria-label="清空搜索关键词" onClick={() => { setDraft(''); setInputError(''); }}><X size={16} /></button>}</label><button className="button primary" type="submit"><Search size={16} />搜索</button></form>
    {(inputError || validation) && <ErrorNotice message={inputError || validation} />}
    <div className="unified-search-controls"><div className="unified-search-types" role="tablist" aria-label="搜索结果类型">{(['all', ...searchTypes] as const).map(type => <button type="button" role="tab" key={type} aria-selected={state.type === type} onClick={() => update({ type, page: 1 })}>{type === 'all' ? '全部' : searchTypeLabels[type]}<span>{hasQuery && counts ? (type === 'all' ? result.data!.totalAll : counts[type]).toLocaleString('zh-CN') : '—'}</span></button>)}</div>
      <div className="unified-search-filters"><label className="unified-search-unpublished"><input type="checkbox" checked={state.includeUnpublished} onChange={event => update({ includeUnpublished: event.target.checked, page: 1 })} />包含未发布题目</label><Field label="结果排序"><select value={state.sort} onChange={event => update({ sort: event.target.value === 'updatedAt' ? 'updatedAt' : 'relevance', page: 1 })}><option value="relevance">按相关度</option><option value="updatedAt">按更新时间</option></select></Field></div>
    </div>
    {!hasQuery ? <section className="card unified-search-welcome"><BookOpen size={29} /><h2>从一个关键词开始</h2><p>可以搜索题号、知识术语、资料内容或自己的学习笔记。多个关键词使用空格分隔，结果需要同时匹配，最多8个词。</p><div>{searchTypes.map(type => { const Icon = icons[type]; return <span key={type}><Icon size={15} />{searchTypeLabels[type]}</span>; })}</div></section>
      : validation ? null : result.loading ? <Loading text="正在查找相关内容…" /> : result.error ? <ErrorNotice message={result.error} retry={result.refresh} /> : result.data && <>
        <div className="unified-search-summary" role="status" aria-label="搜索结果统计"><p>“{result.data.query}”{state.type === 'all' ? '共' : `在${searchTypeLabels[state.type]}中有`} <strong>{result.data.total.toLocaleString('zh-CN')}</strong> 条结果{state.type !== 'all' && <span className="muted"> · 全部类型 {result.data.totalAll.toLocaleString('zh-CN')} 条</span>}</p>{state.includeUnpublished && <span className="badge">含待审核及草稿题目</span>}</div>
        {result.data.items.length ? <ul className="card unified-search-results" aria-label="统一搜索结果">{result.data.items.map(item => <SearchResult key={item.key} item={item} state={state} />)}</ul> : <Empty title={result.data.total ? '这一页没有结果' : '没有找到匹配的内容'} description={result.data.total ? '可以返回第一页继续查看。' : '尝试更短的关键词、减少同时匹配的词，或切换内容类型。'} actions={<div className="unified-empty-actions">{state.page > 1 && <button className="button" onClick={() => update({ page: 1 })}>返回第一页</button>}{state.type !== 'all' && <button className="button" onClick={() => update({ type: 'all', page: 1 })}>查看全部类型</button>}</div>} />}
        <Pagination page={state.page} pageSize={state.pageSize} total={result.data.total} onPage={page => update({ page })} onPageSize={pageSize => update({ pageSize, page: 1 })} label="搜索结果" />
      </>}
    <details className="unified-search-scope"><summary>搜索范围与使用说明</summary><ul><li>题目覆盖题干、组合小题、参考答案和解析。参考内容只用于匹配，不在搜索结果中直接展开。</li><li>题集检索名称与介绍；Markdown资料检索正文及资料信息，PDF目前检索标题、作者、简介等资料信息，不包含PDF全文。</li><li>学习笔记包含整题及组合小题的笔记；点击结果可打开相应内容，并通过“返回搜索结果”恢复筛选和页码。</li><li>默认搜索已发布题目和有效内容。勾选后加入待审核、草稿题目；归档内容、作答回答、编辑草稿和AI配置不在搜索范围。</li><li>忽略英文大小写及全角／半角差异；空格分词按同时匹配处理，不支持正则或通配表达式。所有检索都在本机完成。</li></ul></details>
  </div>;
}
