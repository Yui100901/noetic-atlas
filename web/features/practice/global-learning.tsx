import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, CalendarCheck2, ChevronLeft, ChevronRight, Star, Target } from 'lucide-react';
import type { GlobalLearningKind, GlobalLearningQuestion, GlobalLearningSummary } from '../../../shared/practice/global-learning';
import type { Paged } from '../../../shared/utils/pagination';
import { localDate, qs, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Pagination, QuestionMeta } from '../../shared/ui/components';
import { QuestionViewer, type QuestionViewerHandle } from '../questions/question-viewer';
import { LearningOrigins, snapshotDescription } from './learning-origins';
import './global-learning.css';

const views = [
  { kind: 'wrong', title: '全部错题', Icon: Target, empty: '当前没有错题', description: '汇总各题集、随机抽题与单题自测中最近已判错误或客观题漏答的题目。重新答对后，从对应来源的错题中移出。' },
  { kind: 'favorite', title: '全部收藏', Icon: Star, empty: '当前没有收藏题目', description: '汇总收藏的当前原题。相同题目合并展示，关联题集与答题记录可展开核对。' },
  { kind: 'due', title: '待复习', Icon: CalendarCheck2, empty: '当前没有到期复习', description: '汇总已经到期的当前原题。查看内容、记录掌握程度，系统会安排下次复习。' },
] as const;

export function GlobalLearningPage({ kind }: { kind: GlobalLearningKind }) {
  const view = views.find(value => value.kind === kind)!;
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const summary = useResource<GlobalLearningSummary>('/api/learning/global/summary');
  const questions = useResource<Paged<GlobalLearningQuestion>>(`/api/learning/global/questions?${qs({ kind, page, pageSize })}`);
  const [selected, setSelected] = useState<{ item: GlobalLearningQuestion; index: number; page: number; total: number } | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<'first' | 'last' | null>(null);
  const viewer = useRef<QuestionViewerHandle>(null);
  const refresh = () => { summary.refresh(); questions.refresh(); };
  useEffect(() => {
    if (!pendingNavigation || questions.loading || questions.error || questions.data?.page !== page) return;
    const items = questions.data.items;
    if (items.length) {
      const index = pendingNavigation === 'first' ? 0 : items.length - 1;
      setSelected({ item: items[index], index, page, total: questions.data.total });
    }
    setPendingNavigation(null);
  }, [pendingNavigation, questions.loading, questions.error, questions.data, page]);
  useEffect(() => {
    if (selected || !questions.data || questions.data.page !== page || questions.loading) return;
    const maximum = Math.max(1, Math.ceil(questions.data.total / pageSize));
    if (page > maximum) setPage(maximum);
  }, [questions.data, questions.loading, selected, page, pageSize]);
  const close = () => {
    if (viewer.current?.confirmLeave() === false) return;
    setSelected(null); setPendingNavigation(null); refresh();
  };
  const move = (delta: -1 | 1) => {
    if (!selected || pendingNavigation || !questions.data || viewer.current?.confirmLeave() === false) return;
    const index = selected.index + delta;
    if (selected.page === questions.data.page && index >= 0 && index < questions.data.items.length) setSelected({ item: questions.data.items[index], index, page: selected.page, total: questions.data.total });
    else {
      const nextPage = selected.page + delta;
      if (nextPage < 1 || nextPage > Math.ceil(selected.total / pageSize)) return;
      setPendingNavigation(delta > 0 ? 'first' : 'last'); setPage(nextPage);
    }
    document.querySelector('.global-question-navigation')?.closest('.modal')?.scrollTo({ top: 0 });
  };
  const navigateFromReader = (event: MouseEvent<HTMLAnchorElement>) => {
    if (viewer.current?.confirmLeave() === false) event.preventDefault();
  };
  const currentPosition = selected ? (selected.page - 1) * pageSize + selected.index : 0;
  return <section className="global-learning-page">
    <a className="back-link" href="#/papers"><ArrowLeft size={15} />返回题集与练习</a>
    <PageHeader eyebrow="SMART QUESTION SET" title={view.title} description={view.description} actions={<button type="button" className="button" onClick={refresh}>刷新题集</button>} />
    <nav className="global-learning-tabs" aria-label="系统汇总题集">{views.map(({ kind: value, title, Icon }) => <a key={value} href={`#/learning/${value}`} className={value === kind ? 'selected' : ''} aria-current={value === kind ? 'page' : undefined}><Icon size={17} /><span>{title}</span><strong>{!summary.loading && !summary.error && summary.data ? summary.data.counts[value].toLocaleString() : '—'}</strong></a>)}</nav>
    {summary.error && <ErrorNotice message={`汇总题数刷新失败：${summary.error}`} retry={summary.refresh} />}
    <p className="global-learning-rule">{kind === 'wrong' ? '每题阅读最近一次错误的完整答题快照，保留当时的共用材料与小题；原题修改或删除不替换快照。' : '每题展示当前原题内容。收藏、笔记、掌握程度和复习日期共享原题；关联来源不代表收藏或复习发生的位置。'} 这是动态汇总视图，同一原题的同一小题只列一次，来源可展开查看。</p>
    {questions.loading ? <Loading text={`正在读取${view.title}…`} /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <div className="global-learning-questions">{questions.data.items.map((item, index) => <article className="card global-learning-question" key={item.key}>
      <QuestionMeta question={item.question} /><button type="button" className="text-button global-question-title" onClick={() => setSelected({ item, index, page, total: questions.data!.total })}>{item.question.title}</button>
      {item.question.groupTitle && <p className="muted">共用材料 · {item.question.groupTitle}</p>}
      <p className="global-question-state">{kind === 'wrong' ? <><span className="badge global-wrong-state">{item.answerState === 'unanswered' ? '客观题漏答' : '回答错误'}</span>累计错误 {item.wrongCount} 次</> : item.study?.mastery != null ? `掌握程度 ${item.study.mastery}/3` : '尚未记录掌握程度'}{kind === 'due' && item.study?.nextReviewAt && <> · 复习日期 {localDate(item.study.nextReviewAt)}</>}</p>
      <p className="global-snapshot-description">{snapshotDescription(item)}</p>
      <LearningOrigins item={item} kind={kind} />
      <div className="global-question-actions"><button type="button" className="button" aria-label={`查看汇总题目：${item.question.title}`} onClick={() => setSelected({ item, index, page, total: questions.data!.total })}>查看与复习<ChevronRight size={16} /></button></div>
    </article>)}</div> : <Empty title={view.empty} description={kind === 'wrong' ? '提交练习后，可在这里集中复盘已判定的错题。' : kind === 'favorite' ? '在看题窗口收藏感兴趣的题目，即可在这里集中阅读。' : '记录掌握程度或设置复习日期后，到期题目会出现在这里。'} />}
    {!questions.loading && !questions.error && questions.data && <Pagination page={page} pageSize={pageSize} total={questions.data.total} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label={view.title} />}
    {selected && <Modal title="汇总题集看题" wide onClose={close}>
      <div className="question-viewer-navigation global-question-navigation"><button type="button" className="button" disabled={pendingNavigation !== null || currentPosition <= 0} onClick={() => move(-1)}><ChevronLeft size={16} />上一题</button><span role="status">第 {currentPosition + 1} / {selected.total} 题</span><button type="button" className="button" disabled={pendingNavigation !== null || currentPosition + 1 >= selected.total} onClick={() => move(1)}>下一题<ChevronRight size={16} /></button></div>
      {pendingNavigation && (questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : <Loading text="正在翻到相邻页的题目…" />)}
      <div className="global-question-reading" inert={pendingNavigation !== null} aria-busy={pendingNavigation !== null}>
        <p className="notice info global-reading-snapshot">{snapshotDescription(selected.item)}</p>
        <LearningOrigins item={selected.item} kind={kind} onNavigate={navigateFromReader} />
        <QuestionViewer key={`${selected.item.key}:${selected.item.attemptId || 'current'}`} ref={viewer} question={selected.item.question} contentSource={selected.item.snapshotSource === 'library' ? 'current' : 'snapshot'} onStudyChange={summary.refresh} />
      </div>
    </Modal>}
  </section>;
}
