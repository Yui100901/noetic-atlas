import { useState, type ReactNode } from 'react';
import { ArrowRight, Clock3 } from 'lucide-react';
import type { ContextLearningSummary } from '../../../shared/practice/context-learning';
import { idPath, useResource } from '../../shared/lib/api';
import type { ListPage } from '../../shared/lib/pagination';
import { Empty, ErrorNotice, Loading, Pagination } from '../../shared/ui/components';
import { ContextLearningPanel } from '../practice/context-learning';
import './paper-learning.css';

const tabs = [
  { id: 'content', label: '题集内容' },
  { id: 'wrong', label: '错题集' },
  { id: 'review', label: '复习建议' },
  { id: 'drafts', label: '作答草稿' },
  { id: 'history', label: '历史答题' },
] as const;

/** Keep the question browser mounted so switching to a set's history does not
 * reset its current search/page. No extra global learning-record destination. */
export function PaperLearningWorkspace({ paperId, initialTab = 'content', children }: { paperId: string; initialTab?: string; children: ReactNode }) {
  const [tab, setTab] = useState(tabs.some(item => item.id === initialTab) ? initialTab : 'content');
  return <section className="paper-learning-workspace">
    <div className="section-tabs paper-learning-tabs" role="tablist" aria-label="题集学习内容">
      {tabs.map(item => <button key={item.id} id={`set-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`set-panel-${item.id}`} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <div id="set-panel-content" role="tabpanel" aria-labelledby="set-tab-content" hidden={tab !== 'content'}>{children}</div>
    {tab !== 'content' && <div id={`set-panel-${tab}`} role="tabpanel" aria-labelledby={`set-tab-${tab}`}><ContextLearningPanel key={`${paperId}:${tab}`} source="paper" paperId={paperId} initialTab={tab} showTabs={false} /></div>}
  </section>;
}

/** Deleted sets are represented by retained attempts, never re-created as
 * editable sets. This entry also keeps historical drafts reachable. */
export function RetainedSetHistories() {
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const contexts = useResource<ListPage<ContextLearningSummary>>(`/api/learning/contexts?page=${page}&pageSize=${pageSize}`);
  if (!contexts.loading && !contexts.error && !contexts.data?.total) return null;
  return <details className="card retained-set-histories">
    <summary><Clock3 size={17} /><span>已删除题集的历史</span>{contexts.data && <span className="badge">{contexts.data.total} 份</span>}</summary>
    <p className="muted">源题集已删除，已保存的作答、草稿和错题快照仍可查看。</p>
    {contexts.loading ? <Loading /> : contexts.error ? <ErrorNotice message={contexts.error} retry={contexts.refresh} /> : contexts.data?.items.length ? <>
      <div className="retained-set-list">{contexts.data.items.map(context => <a key={context.paperId} href={`#/papers/${idPath(context.paperId!)}/activity?tab=history`}><div><strong>{context.title}</strong><p>{context.counts.drafts} 份草稿 · {context.counts.submitted} 次已提交作答 · {context.counts.wrong} 道待巩固错题</p></div><ArrowRight size={16} /></a>)}</div>
      <Pagination page={page} pageSize={pageSize} total={contexts.data.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="已删除题集" />
    </> : <Empty title="没有保留的历史" />}
  </details>;
}
