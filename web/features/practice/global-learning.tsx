import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarCheck2, ChevronRight, Star, Target } from 'lucide-react';
import type { GlobalLearningKind, GlobalLearningQuestion, GlobalLearningSummary } from '../../../shared/practice/global-learning';
import type { Paged } from '../../../shared/utils/pagination';
import { localDate, qs, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, QuestionMeta, useApp } from '../../shared/ui/components';
import { LearningOrigins, snapshotDescription } from './learning-origins';
import './global-learning.css';
import { AdaptiveReviewQueue } from '../review-scheduler/review-queue';
import { DEFAULT_REVIEW_SCHEDULING } from '../../../shared/models/settings';
import {learningListHref,learningReaderHref,readLearningPagination} from './learning-reader-navigation';

const views = [
  { kind: 'wrong', title: '全部错题', Icon: Target, empty: '当前没有错题', description: '汇总各题集、随机抽题与单题自测中最近已判错误或客观题漏答的题目。重新答对后，从对应来源的错题中移出。' },
  { kind: 'favorite', title: '全部收藏', Icon: Star, empty: '当前没有收藏题目', description: '汇总收藏的当前原题。相同题目合并展示，关联题集与答题记录可展开核对。' },
  { kind: 'due', title: '待复习', Icon: CalendarCheck2, empty: '当前没有到期复习', description: '汇总已经到期的当前原题。查看内容、记录掌握程度，系统会安排下次复习。' },
] as const;

export function GlobalLearningPage({ kind }: { kind: GlobalLearningKind }) {
  const { bootstrap } = useApp();
  const adaptive = kind === 'due' && (bootstrap.settings?.reviewScheduling || DEFAULT_REVIEW_SCHEDULING).strategy === 'fsrs';
  const view = views.find(value => value.kind === kind)!;
  const [initial]=useState(()=>readLearningPagination(new URLSearchParams(window.location.hash.split('?')[1])));
  const [page, setPage] = useState(initial.page), [pageSize, setPageSize] = useState(initial.pageSize);
  const context={scope:'global' as const,kind,page,pageSize};
  useEffect(()=>{if(!adaptive)history.replaceState(history.state,'',learningListHref(context));},[kind,page,pageSize,adaptive]);
  const summary = useResource<GlobalLearningSummary>('/api/learning/global/summary');
  const questions = useResource<Paged<GlobalLearningQuestion>>(adaptive ? null : `/api/learning/global/questions?${qs({ kind, page, pageSize })}`);
  const refresh = () => { summary.refresh(); questions.refresh(); };
  useEffect(()=>{if(!questions.data||questions.loading)return;const maximum=Math.max(1,Math.ceil(questions.data.total/pageSize));if(page>maximum)setPage(maximum);},[questions.data,questions.loading,page,pageSize]);
  return <section className="global-learning-page">
    <a className="back-link" href="#/papers"><ArrowLeft size={15} />返回题集与练习</a>
    <PageHeader eyebrow="SMART QUESTION SET" title={view.title} description={view.description} actions={<button type="button" className="button" onClick={refresh}>刷新题集</button>} />
    <nav className="global-learning-tabs" aria-label="系统汇总题集">{views.map(({ kind: value, title, Icon }) => <a key={value} href={`#/learning/${value}`} className={value === kind ? 'selected' : ''} aria-current={value === kind ? 'page' : undefined}><Icon size={17} /><span>{title}</span><strong>{!summary.loading && !summary.error && summary.data ? summary.data.counts[value].toLocaleString() : '—'}</strong></a>)}</nav>
    {summary.error && <ErrorNotice message={`汇总题数刷新失败：${summary.error}`} retry={summary.refresh} />}
    {adaptive && <AdaptiveReviewQueue />}
    {!adaptive && <>
    <p className="global-learning-rule">{kind === 'wrong' ? '每题阅读最近一次错误的题目快照，保留当时的共用材料；清理整卷历史、修改或删除原题不影响错误内容与来源摘要。' : '每题展示当前原题内容。收藏共享原题；组合小题分别记录笔记、掌握程度和复习日期。关联来源不代表收藏或复习发生的位置。'} 这是动态汇总视图，同一原题的同一小题只列一次，来源可展开查看。</p>
    {questions.loading ? <Loading text={`正在读取${view.title}…`} /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <div className="global-learning-questions">{questions.data.items.map((item, index) => <article className="card global-learning-question" key={item.key}>
      <QuestionMeta question={item.question} /><a className="text-button global-question-title" href={learningReaderHref(context,item.key)}>{item.question.title}</a>
      {item.question.groupTitle && <p className="muted">共用材料 · {item.question.groupTitle}</p>}
      <p className="global-question-state">{kind === 'wrong' ? <><span className="badge global-wrong-state">{item.answerState === 'unanswered' ? '客观题漏答' : '回答错误'}</span>累计错误 {item.wrongCount} 次</> : item.study?.mastery != null ? `掌握程度 ${item.study.mastery}/3` : '尚未记录掌握程度'}{kind === 'due' && item.study?.nextReviewAt && <> · 复习日期 {localDate(item.study.nextReviewAt)}</>}</p>
      <p className="global-snapshot-description">{snapshotDescription(item)}</p>
      <LearningOrigins item={item} kind={kind} />
      <div className="global-question-actions"><a className="button" aria-label={`查看汇总题目：${item.question.title}`} href={learningReaderHref(context,item.key)}>查看与复习<ChevronRight size={16} /></a></div>
    </article>)}</div> : <Empty title={view.empty} description={kind === 'wrong' ? '提交练习后，可在这里集中复盘已判定的错题。' : kind === 'favorite' ? '在题目详情页收藏感兴趣的题目，即可在这里集中阅读。' : '记录掌握程度或设置复习日期后，到期题目会出现在这里。'} />}
    {!questions.loading && !questions.error && questions.data && <Pagination page={page} pageSize={pageSize} total={questions.data.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label={view.title} />}
    </>}
  </section>;
}
