import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarCheck2, ChevronRight, Clock3, History, NotebookPen, Star, Target } from 'lucide-react';
import type { AttemptHistoryItem, ContextLearningQuestion, ContextLearningSummary, LearningSource } from '../../../shared/practice/context-learning';
import type { Paged } from '../../../shared/utils/pagination';
import { durationText } from '../../../shared/practice/attempt-timing';
import { href, localDate, qs, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, QuestionMeta } from '../../shared/ui/components';
import { pointText } from '../../shared/lib/scoring';
import './context-learning.css';
import { vocabularyDirectionLabel } from '../papers/vocabulary-practice';
import {learningListHref,learningReaderHref,readLearningPagination,type LearningReaderContext} from './learning-reader-navigation';

type LearningTab = 'wrong' | 'favorite' | 'review' | 'drafts' | 'history';
interface ContextLearningPanelProps {
  source: LearningSource;
  paperId?: string;
  initialTab?: string;
  refreshKey?: string | number;
  showTabs?: boolean;
}
const normalizeTab = (value?: string): LearningTab => value === 'wrong' || value === 'favorite' || value === 'drafts' || value === 'history' ? value : 'review';
const tabLabels = { wrong: '错题集', favorite: '收藏集', review: '复习建议', drafts: '作答草稿', history: '历史答题' };
const emptyDescriptions: Record<string, [string, string]> = {
  wrong: ['当前没有错题', '提交练习后，最近一次已经判定为错误或客观题漏答的题目会出现在这里；重新答对后移出。'],
  due: ['当前没有到期复习', '查看题目并记录掌握程度后，系统会安排下次复习；尚未到期的题目不会列入这里。'],
  favorite: ['当前没有收藏题目', '在题目详情页收藏想再看的题目。收藏与原题共用，同一题可以出现在多个题集中。'],
  drafts: ['当前没有作答草稿', '开始练习后，尚未提交的答案自动保存在这里。选择已有草稿即可继续同一次作答。'],
  history: ['还没有已提交的答题', '完成练习或考试后，可在这里回顾答案、解析、用时和判分。'],
};

function contextQuery(source: LearningSource, paperId?: string) { return qs({ source, ...(source === 'paper' ? { paperId } : {}) }); }
function useContextSummary(source: LearningSource, paperId?: string) {
  return useResource<ContextLearningSummary>(source === 'paper' && !paperId ? null : `/api/learning/summary?${contextQuery(source, paperId)}`);
}

/** Shared contextual learning surface; reads only compact, paginated records. */
export function ContextLearningPanel(props: ContextLearningPanelProps) {
  const summary = useContextSummary(props.source, props.paperId);
  return <LearningPanelBody {...props} summaryResource={summary} />;
}

function LearningPanelBody({ source, paperId, initialTab, refreshKey, showTabs = true, summaryResource }: ContextLearningPanelProps & { summaryResource: ReturnType<typeof useContextSummary> }) {
  const [tab, setTab] = useState<LearningTab>(() => normalizeTab(initialTab));
  const [reviewKind, setReviewKind] = useState<'due' | 'favorite'>(()=>initialTab==='favorite'||new URLSearchParams(window.location.hash.split('?')[1]).get('reviewKind')==='favorite'?'favorite':'due');
  const [initial]=useState(()=>readLearningPagination(new URLSearchParams(window.location.hash.split('?')[1])));
  const [page,setPage]=useState(initial.page),[pageSize,setPageSize]=useState(initial.pageSize);
  const query = contextQuery(source, paperId);
  const kind = tab === 'wrong' ? 'wrong' : tab === 'favorite' ? 'favorite' : reviewKind;
  const scopeLabel = source === 'quick' ? '随机答题' : '本题集';
  const showQuestions = tab === 'wrong' || tab === 'favorite' || tab === 'review';
  const contextValid = source === 'quick' || !!paperId;
  const questions = useResource<Paged<ContextLearningQuestion>>(contextValid && showQuestions ? `/api/learning/questions?${query}&${qs({ kind, page, pageSize })}` : null);
  const attempts = useResource<Paged<AttemptHistoryItem>>(contextValid && !showQuestions ? `/api/learning/attempts?${query}&${qs({ status: tab === 'drafts' ? 'in_progress' : 'submitted', page, pageSize })}` : null);
  const { data: freshSummary, loading: summaryLoading, error: summaryError, refresh: refreshSummary } = summaryResource;
  const lastSummary = useRef<ContextLearningSummary | null>(null);
  if (freshSummary) lastSummary.current = freshSummary;
  // An auxiliary count refresh must never unmount an open reader and discard
  // unsaved notes when its request fails after a successful study update.
  const summary = freshSummary || lastSummary.current;
  const previousRefresh = useRef(refreshKey);
  const refreshLists = () => { refreshSummary(); if (showQuestions) questions.refresh(); else attempts.refresh(); };
  useEffect(() => {
    if (previousRefresh.current === refreshKey) return;
    previousRefresh.current = refreshKey;
    refreshLists();
  }, [refreshKey]);
  const pageData = showQuestions ? questions.data : attempts.data;
  // A favorite or due list can shrink after a learning update. Keep pagination
  // valid after returning from a reader that changed its membership.
  useEffect(() => {
    if (!pageData || pageData.page !== page) return;
    const maximum = Math.max(1, Math.ceil(pageData.total / pageSize));
    if (page > maximum) setPage(maximum);
  }, [pageData, page, pageSize]);
  const changeTab = (next: LearningTab) => { setTab(next); setPage(1); };
  const changeReviewKind = (next: 'due' | 'favorite') => { setReviewKind(next); setPage(1); };
  const context:LearningReaderContext={scope:source==='paper'?'paper' as const:'quick' as const,kind,paperId,activity:window.location.hash.split('?')[0].endsWith('/activity'),tab,page,pageSize};
  useEffect(()=>{history.replaceState(history.state,'',learningListHref(context));},[source,paperId,tab,kind,page,pageSize]);
  const panelId = useId();
  if (!contextValid) return <ErrorNotice message="缺少题集标识，无法读取学习进度。" />;
  if (summaryLoading && !summary) return <Loading text={`正在读取${scopeLabel}的学习进度…`} />;
  if (!summary) return <ErrorNotice message={summaryError || '无法读取学习进度'} retry={refreshSummary} />;
  const tabs = [
    { id: 'wrong' as const, label: tabLabels.wrong, count: summary.counts.wrong, Icon: Target },
    { id: 'favorite' as const, label: tabLabels.favorite, count: summary.counts.favorite, Icon: Star },
    { id: 'review' as const, label: tabLabels.review, count: summary.counts.due, Icon: CalendarCheck2 },
    { id: 'drafts' as const, label: tabLabels.drafts, count: summary.counts.drafts, Icon: NotebookPen },
    { id: 'history' as const, label: tabLabels.history, count: summary.counts.submitted, Icon: History },
  ];
  const list = showQuestions ? questions : attempts;
  const emptyKey = showQuestions ? kind : tab;
  const [emptyTitle, emptyDescription] = emptyDescriptions[emptyKey];
  return <section className="context-learning-panel" aria-label={source === 'quick' ? '随机答题学习进度' : '题集学习进度'}>
    {summaryError && <ErrorNotice message={`进度刷新失败，仍显示上次结果：${summaryError}`} retry={refreshSummary} />}
    {showTabs && <div className="section-tabs context-learning-tabs" role="tablist" aria-label="学习内容">{tabs.map(({ id, label, count, Icon }) => <button type="button" role="tab" id={`${panelId}-${id}`} aria-controls={`${panelId}-content`} aria-selected={tab === id} className={tab === id ? 'selected' : ''} key={id} onClick={() => changeTab(id)}><Icon size={16} />{label}<span>{count.toLocaleString()}</span></button>)}</div>}
    <div id={`${panelId}-content`} {...(showTabs ? { role: 'tabpanel', 'aria-labelledby': `${panelId}-${tab}` } : {})}>
      <div className="context-learning-heading"><div><h2>{tabLabels[tab]}</h2><p>{source === 'quick' ? '仅包含随机抽题与单题自测的作答。' : '仅包含这份题集中的学习与作答。'}</p></div><button type="button" className="text-button" onClick={refreshLists}>刷新进度</button></div>
      {tab === 'review' && <>
        <section className="card context-review-suggestions"><h3><CalendarCheck2 size={18} />下一步学习建议</h3>{summary.suggestions.length ? <ul>{summary.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul> : <p className="muted">先完成一次练习，再根据错题与掌握程度安排复习。</p>}<p className="context-rule-note">建议依据{scopeLabel}的最近答题结果、到期日期和收藏数量生成，使用本地规则，不调用 AI，也不代表完整能力评估。</p></section>
        <div className="context-review-switch segmented" aria-label="复习题目范围"><button type="button" className={reviewKind === 'due' ? 'selected' : ''} aria-pressed={reviewKind === 'due'} onClick={() => changeReviewKind('due')}><CalendarCheck2 size={15} />到期复习 <span>{summary.counts.due}</span></button><button type="button" className={reviewKind === 'favorite' ? 'selected' : ''} aria-pressed={reviewKind === 'favorite'} onClick={() => changeReviewKind('favorite')}><Star size={15} />我的收藏 <span>{summary.counts.favorite}</span></button></div>
      </>}
      {showQuestions && <p className="context-rule-note">{tab === 'wrong' ? `错题按${scopeLabel}最近一次已判结果整理，包含客观题漏答；清理历史不影响错题与来源，后续未判主观作答不会清除已有错题，重新答对后移出。` : `到期复习与收藏仅展示${scopeLabel}相关题目。`}收藏共享原题；组合小题分别记录掌握、笔记与复习日期，阅读保留公共材料。</p>}
      {list.loading ? <Loading text={showQuestions ? '正在读取相关题目…' : '正在读取作答记录…'} /> : list.error ? <ErrorNotice message={list.error} retry={list.refresh} /> : pageData?.items.length ? showQuestions ? <div className="context-learning-questions">{questions.data!.items.map((item, index) => <article className="card context-learning-question" key={`${item.question.id}-${item.attemptId || 'set'}`}><div><QuestionMeta question={item.question} /><a className="text-button context-learning-question-title" href={learningReaderHref(context,item.question.id)}>{item.question.title}</a>{item.question.groupTitle && <p className="muted">共用材料 · {item.question.groupTitle}</p>}<p className="context-question-state">{tab === 'wrong' && item.answerState && <span className="badge context-wrong-state">{item.answerState === 'unanswered' ? '未作答' : '回答错误'} </span>}{tab === 'wrong' ? `累计错误 ${item.wrongCount} 次` : item.study?.mastery != null ? `掌握程度 ${item.study.mastery}/3` : '尚未记录掌握程度'}{item.lastPracticedAt && <> · 最近练习 {localDate(item.lastPracticedAt)}</>}{kind === 'due' && item.study?.nextReviewAt && <> · 复习日期 {localDate(item.study.nextReviewAt)}</>}</p></div><a className="button" aria-label={`查看学习题目：${item.question.title}`} href={learningReaderHref(context,item.question.id)}>查看与复习<ChevronRight size={16} /></a></article>)}</div> : <ContextAttemptRows items={attempts.data!.items} /> : <Empty title={emptyTitle} description={emptyDescription} />}
      {!list.loading && !list.error && pageData && <Pagination page={page} pageSize={pageSize} total={pageData.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label={`上下文${tabLabels[tab]}`} />}
    </div>

  </section>;
}

function ContextAttemptRows({ items }: { items: AttemptHistoryItem[] }) {
  return <div className="context-attempt-list">{items.map(item => <a className="card context-attempt-row" href={href('attempts', item.id)} aria-label={`${item.status === 'in_progress' ? '继续作答' : '查看作答'}：${item.id}`} key={item.id}><span className={`context-attempt-icon ${item.status}`}><Clock3 size={20} /></span><div className="context-attempt-main"><h3>{item.paperTitle}</h3><p>{item.status === 'in_progress' ? '最后保存 ' : '提交于 '}{localDate(item.status === 'in_progress' ? item.updatedAt : item.submittedAt || item.startedAt)} · {item.source === 'paper' ? `v${item.paperVersion} · ` : ''}{item.practiceMode === 'exam' ? '限时考试' : '普通练习'}{item.vocabularyDirection && ` · ${vocabularyDirectionLabel(item.vocabularyDirection, item.practiceKind)}`}{item.referenceViewedAt && ' · 已查看参考解析'}</p><p>已答 {item.answeredCount}/{item.questionCount} 题{item.status === 'submitted' && <> · 用时 {durationText(item.elapsedSeconds)}{item.autoSubmitted ? ' · 到时交卷' : ''}</>}{item.status === 'in_progress' && item.deadlineAt && <> · 截止 {localDate(item.deadlineAt)}</>}</p></div><div className="context-attempt-result"><span className={`badge ${item.status === 'in_progress' ? 'status-muted' : ''}`}>{item.status === 'in_progress' ? '继续作答' : '查看复盘'}</span>{item.status === 'submitted' && <p>{!item.scoringEnabled ? '无分练习' : item.totalScore != null ? `总分 ${pointText(item.totalScore)} / ${pointText(item.totalPoints)}` : `${item.objectiveMax ? `客观 ${pointText(item.objectiveScore)} / ${pointText(item.objectiveMax)} · ` : ''}${item.pendingSubjectiveCount} 道主观题待阅`}</p>}</div><ArrowRight size={17} /></a>)}</div>;
}

/** Deleted sets remain reachable from individual attempt back-links. */
export function DeletedSetActivityPage({ paperId, initialTab = 'history' }: { paperId: string; initialTab?: string }) {
  const summary = useContextSummary('paper', paperId);
  return <><a className="back-link" href="#/papers"><ArrowLeft size={15} />返回题集列表</a><PageHeader eyebrow="SAVED PRACTICE" title={summary.data?.title || '题集历史'} description="原题集已删除，已保存的作答草稿、答题快照和历史仍可继续查看。" />{summary.data && !summary.data.deleted && <p className="notice info">原题集仍然存在，<a href={href('papers', paperId)}>返回题集内容</a>。</p>}<LearningPanelBody source="paper" paperId={paperId} initialTab={initialTab} summaryResource={summary} /></>;
}
