import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarClock, RefreshCw } from 'lucide-react';
import type { ReviewDirection, ReviewQueue, ReviewQueueItem } from '../../../shared/models/adaptive-review';
import type { Question } from '../../../shared/models/types';
import { DEFAULT_REVIEW_SCHEDULING } from '../../../shared/models/settings';
import { idPath, localDate, qs, useResource } from '../../shared/lib/api';
import { CategoryOptions, Empty, ErrorNotice, Field, Loading, Modal, Pagination, useApp } from '../../shared/ui/components';
import { GroupStudyTools, QuestionViewer, type QuestionSnapshot, type QuestionViewerHandle } from '../questions/question-viewer';
import { QuestionContent } from '../../shared/ui/content-notices';
import './review-scheduling.css';

type QueueKind = 'all' | 'overdue' | 'relearning' | 'today';
const labels = { all: '全部到期', overdue: '已经逾期', relearning: '短期重学', today: '今日到期' };
const directions: Record<ReviewDirection, string> = { standard: '普通练习', word_to_meaning: '词卡／概念顺向', meaning_to_word: '词卡／概念逆向' };

export function AdaptiveReviewQueue() {
  const { bootstrap } = useApp();
  const enabled = (bootstrap.settings?.reviewScheduling || DEFAULT_REVIEW_SCHEDULING).strategy === 'fsrs';
  const [kind, setKind] = useState<QueueKind>('all'), [domainId, setDomainId] = useState(''), [categoryId, setCategoryId] = useState(''), [direction, setDirection] = useState('');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const [reading, setReading] = useState<ReviewQueueItem | null>(null), viewer = useRef<QuestionViewerHandle>(null);
  const resource = useResource<ReviewQueue>(enabled ? `/api/review-scheduler/queue?${qs({ kind, domainId, categoryId, direction, page, pageSize })}` : null);
  useEffect(() => { if (!enabled) return; const refresh = () => { if (document.visibilityState === 'visible' && !document.body.classList.contains('exam-active')) resource.refresh(); }; const timer = setInterval(refresh, 30000); window.addEventListener('focus', refresh); return () => { clearInterval(timer); window.removeEventListener('focus', refresh); }; }, [enabled, resource.refresh]);
  useEffect(() => { if (!resource.data || resource.loading) return; const maximum = Math.max(1, Math.ceil(resource.data.total / pageSize)); if (page > maximum) setPage(maximum); }, [resource.data, resource.loading, page, pageSize]);
  if (!enabled) return null;
  const change = (name: 'domain' | 'category' | 'direction' | 'kind', value: string) => { setPage(1); if (name === 'domain') { setDomainId(value); setCategoryId(''); } else if (name === 'category') setCategoryId(value); else if (name === 'direction') setDirection(value); else setKind(value as QueueKind); };
  return <section className="card adaptive-queue" aria-label="自适应复习队列"><div className="adaptive-queue-heading"><div><h2><CalendarClock size={17} />实时复习队列</h2><p>按当前时刻读取到期任务，短期重学到时会进入队列。原有复习日期继续保留，首次有效复习后建立FSRS状态。</p></div><button className="button" type="button" disabled={resource.loading} aria-label="刷新实时复习队列" onClick={resource.refresh}><RefreshCw size={15} />刷新</button></div>
    {resource.data && <div className="adaptive-queue-counts"><span>当前到期 <strong>{resource.data.summary.due}</strong> 项</span><span>逾期 {resource.data.summary.overdue}</span><span>短期重学 {resource.data.summary.relearning}</span><span>已暂停 {resource.data.summary.suspended}</span></div>}
    <div className="adaptive-queue-filters"><Field label="复习任务"><select value={kind} onChange={event => change('kind', event.target.value)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="复习领域"><select value={domainId} onChange={event => change('domain', event.target.value)}><option value="">所有领域</option>{bootstrap.domains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></Field><Field label="复习分类"><select value={categoryId} onChange={event => change('category', event.target.value)}><option value="">所有分类</option><CategoryOptions categories={bootstrap.categories} domainId={domainId || undefined} /></select></Field><Field label="任务方向"><select value={direction} onChange={event => change('direction', event.target.value)}><option value="">全部方向</option>{Object.entries(directions).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field></div>
    {resource.loading ? <Loading text="正在读取到期复习…" /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : resource.data?.items.length ? <div className="adaptive-queue-list">{resource.data.items.map(item => <article className="adaptive-queue-item" key={item.key}><div><strong>{item.direction === 'meaning_to_word' ? (item.practiceKind === 'concept' ? '概念逆向任务 · 看描述想概念' : '词汇逆向任务 · 看释义想词') : <>{item.title}{item.partTitle ? ` · ${item.partTitle}` : ''}</>}</strong><p>{item.reason === 'legacy' ? '原有复习安排' : item.reason === 'relearning' ? '短期重学' : item.reason === 'overdue' ? '已逾期' : '今日到期'} · {item.practiceKind === 'concept' && item.direction === 'standard' ? '概念顺向 · 沿用原复习计划' : directions[item.logicalDirection || item.direction]} · {localDate(item.dueAt)}</p></div><button className="button feature-entry" type="button" aria-label={`复习任务：${item.direction === 'meaning_to_word' ? (item.practiceKind === 'concept' ? '看描述想概念' : '看释义想词') : item.title}`} onClick={() => setReading(item)}>查看与复习<ArrowRight size={14} /></button></article>)}</div> : <Empty title="目前没有到期任务" description="未到期和已暂停的任务不会混入队列；可以继续学习新题，或稍后刷新。" />}
    {!resource.loading && !resource.error && resource.data && <Pagination page={page} pageSize={pageSize} total={resource.data.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="实时复习任务" />}
    {reading && <Modal title={reading.direction === 'meaning_to_word' ? (reading.practiceKind === 'concept' ? '概念逆向复习：看描述想概念' : '逆向复习：看释义想词') : '复习任务看题'} wide onClose={() => { if (viewer.current?.confirmLeave() === false) return; setReading(null); resource.refresh(); }}><QueueReader key={reading.key} item={reading} viewer={viewer} onChanged={resource.refresh} /></Modal>}
  </section>;
}

function QueueReader({ item, viewer, onChanged }: { item: ReviewQueueItem; viewer: React.RefObject<QuestionViewerHandle | null>; onChanged: () => void }) {
  const resource = useResource<Question>(`/api/questions/${idPath(item.questionId)}`);
  if (resource.loading) return <Loading text="正在读取复习题目…" />;
  if (resource.error || !resource.data) return <ErrorNotice message={resource.error || '原题已不可用，请关闭并刷新队列'} retry={resource.refresh} />;
  const question = resource.data;
  if (question.type === 'group' && !item.partId) return <><p className="notice info">这是一项旧整组复习安排。请选择小题分别核对和记录回忆，公共材料继续保留。</p><QuestionContent questionType={question.type}>{question.stemMarkdown}</QuestionContent><GroupStudyTools ref={viewer} question={question} onStudyChange={onChanged} /></>;
  const part = item.partId ? question.parts?.find(value => value.id === item.partId) : undefined;
  if (item.partId && !part) return <ErrorNotice message="该小题已被修改或删除，请关闭后刷新队列" />;
  const snapshot: QuestionSnapshot = part ? { ...question, ...part, id: `${question.id}::${part.id}`, parts: undefined, sourceQuestionId: question.id, partId: part.id, groupTitle: question.title, groupStemMarkdown: question.stemMarkdown } : question;
  return <QuestionViewer ref={viewer} question={snapshot} contentSource="current" reviewDirection={item.direction} onStudyChange={onChanged} />;
}
