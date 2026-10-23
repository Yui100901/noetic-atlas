import { useState } from 'react';
import { ArrowRight, CalendarCheck2, Clock3, History, Play, Star, Target } from 'lucide-react';
import type { Attempt, Paper, QuestionPage } from '../../../shared/models/types';
import { href, localDate, useDebounced, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, SearchBox, useApp } from '../../shared/ui/components';
import { emptyFilters, FiltersPanel, questionQuery, QuestionRow, type Filters } from '../questions/questions';
import { attemptGrading, pointText } from '../../shared/lib/scoring';
import './practice-session.css';
import { usePagination } from '../../shared/lib/pagination';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import { durationText } from '../../../shared/practice/attempt-timing';

function HistoryScore({ attempt }: { attempt: Attempt }) {
  const { scoring, pending, total } = attemptGrading(attempt);
  if (!scoring.enabled) return <p>无分练习 · 核对正误与掌握度</p>;
  return <p>{scoring.scheme === 'legacy' ? '旧版计分 · ' : ''}客观 {pointText(attempt.objectiveScore)}/{pointText(attempt.objectiveMax)}{pending ? ` · ${pending} 道主观题待阅` : ` · 总分 ${pointText(total ?? 0)}/${pointText(scoring.totalPoints)}`}</p>;
}

function HistoryRows({ attempts }: { attempts: Attempt[] }) {
  const paging=usePagination(attempts,attempts.map(item=>item.id).join(","));
  return <><div className="history-list">{paging.items.map(attempt => {
    const quick = attempt.source === 'quick' || attempt.paperId === 'quick-practice';
    const count = attempt.questions.filter(question => { const value = attempt.answers[question.id]?.value; return Array.isArray(value) ? value.some(text => text.trim()) : !!value?.trim(); }).length;
    return <a href={href('attempts', attempt.id)} key={attempt.id}><span className={`history-icon ${attempt.status}`}><Clock3 size={18} /></span><div><strong>{quick ? attempt.questions[0]?.groupTitle || attempt.questions[0]?.title || attempt.paperTitle : attempt.paperTitle}</strong><p>{attempt.status === 'in_progress' ? '最后保存 ' : '提交于 '}{localDate(attempt.status === 'in_progress' ? attempt.updatedAt || attempt.startedAt : attempt.submittedAt || attempt.startedAt)}{!quick && <> <span className="dot">·</span> v{attempt.paperVersion}{attempt.status === 'submitted' && attempt.elapsedSeconds != null && <> <span className="dot">·</span> {attempt.practiceMode === 'exam' ? '考试用时' : '作答用时'} {durationText(attempt.elapsedSeconds)}{attempt.autoSubmitted ? ' · 到时交卷' : ''}</>}</>}{attempt.referenceViewedAt && <> <span className="dot">·</span> 已查看参考解析</>}</p></div><div><span className={`badge ${attempt.status === 'in_progress' ? 'status-muted' : ''}`}>{attempt.status === 'in_progress' ? `草稿 · 已答 ${count}/${attempt.questions.length} · 继续` : '已提交 · 查看复盘'}</span>{attempt.status === 'submitted' && <HistoryScore attempt={attempt} />}</div><ArrowRight size={16} /></a>;
  })}</div><Pagination {...paging} label="练习记录"/></>;
}

function HistoryGroups({ attempts }: { attempts: Attempt[] }) {
  const { bootstrap } = useApp(); const settings = bootstrap.settings || DEFAULT_SETTINGS;
  const papers = useResource<Paper[]>('/api/papers?archived=true');
  const sorted = [...attempts].sort((a, b) => (b.updatedAt || b.submittedAt || b.startedAt).localeCompare(a.updatedAt || a.submittedAt || a.startedAt));
  const quick = sorted.filter(attempt => attempt.source === 'quick' || attempt.paperId === 'quick-practice');
  const groups = new Map<string, Attempt[]>();
  for (const attempt of sorted.filter(item => item.source !== 'quick' && item.paperId !== 'quick-practice')) groups.set(attempt.paperId, [...(groups.get(attempt.paperId) || []), attempt]);
  const groupPaging=usePagination([...groups], [...groups.keys()].join(","));
  const contents = (items: Attempt[], quickGroup = false) => { const drafts = items.filter(attempt => attempt.status === 'in_progress'); const submitted = items.filter(attempt => attempt.status === 'submitted'); const draftMaximum = quickGroup ? settings.maxQuickDrafts : settings.maxDraftsPerPaper; const historyMaximum = quickGroup ? settings.maxQuickHistory : settings.maxHistoryPerPaper; return <div className="history-group-content">{drafts.length > 0 && <section><h3>最近草稿 <span className="muted">{drafts.length} / {draftMaximum}</span></h3><HistoryRows attempts={drafts} /></section>}{submitted.length > 0 && <section><h3>已提交的练习 <span className="muted">{submitted.length}{historyMaximum ? ` / ${historyMaximum}` : ' · 不限数量'}</span></h3><HistoryRows attempts={submitted} /></section>}</div>; };
  return <div className="history-groups">{quick.length > 0 && <details className="card history-group" open><summary><span>随机答题与单题自测</span><span className="badge">{quick.length} 次</span></summary>{contents(quick, true)}</details>}{groupPaging.items.map(([paperId, items], index) => { const exists = papers.data?.some(paper => paper.id === paperId); return <details className="card history-group" key={paperId} open={index === 0}><summary><span>{items[0].paperTitle}</span><span className="badge">{items.length} 次</span></summary><div className="history-group-link">{papers.data && !exists ? <p className="deleted-paper-notice">原练习卷已删除，作答快照保留，可点击下方记录继续或复盘。</p> : <a className="text-button" href={href('papers', paperId)}>查看练习卷与继续入口 →</a>}</div>{contents(items)}</details>; })}{groups.size>0&&<Pagination {...groupPaging} label="历史练习卷分组"/>}</div>;
}

export function StudyPage({ initialTab = 'due' }: { initialTab?: string }) {
  const { bootstrap } = useApp(); const [tab, setTab] = useState(initialTab); const [filters, setFilters] = useState<Filters>({ ...emptyFilters }); const [page, setPage] = useState(1); const [pageSize,setPageSize]=useState(20); const [attemptSearch, setAttemptSearch] = useState(''); const debounced = useDebounced(filters);
  const questionFilters = { ...debounced, favorite: tab === 'favorite', due: tab === 'due', wrong: tab === 'wrong' };
  const questions = useResource<QuestionPage>(tab !== 'history' ? questionQuery(questionFilters, page,pageSize) : null); const attempts = useResource<Attempt[]>(tab === 'history' ? '/api/attempts' : null);
  const tabs = [{ id: 'due', label: '到期复习', count: bootstrap.stats.dueCount, Icon: CalendarCheck2 }, { id: 'favorite', label: '我的收藏', count: bootstrap.stats.favoriteCount, Icon: Star }, { id: 'wrong', label: '错题记录', count: bootstrap.stats.wrongCount, Icon: Target }, { id: 'history', label: '练习历史', Icon: History }];
  const filteredAttempts = attempts.data?.filter(attempt => `${attempt.paperTitle} ${attempt.questions.map(question => question.title).join(' ')}`.toLowerCase().includes(attemptSearch.toLowerCase())) || [];
  return <><PageHeader eyebrow="SMALL STEPS, LASTING KNOWLEDGE" title="学过的知识，值得再见一面。" description="回顾到期知识、整理错题，或继续一份尚未完成的练习。真实的进度，比漂亮的分数更重要。" actions={<a className="button" href="#/papers"><Play size={16} />开始新练习</a>} /><div className="study-stat-grid">{tabs.slice(0, 3).map(({ id, label, count, Icon }) => <button className={`card study-stat ${tab === id ? 'active' : ''}`} key={id} onClick={() => { setTab(id); setPage(1); }}><Icon size={20} /><strong>{count}</strong><span>{label}</span><ArrowRight size={15} /></button>)}</div><div className="section-tabs">{tabs.map(({ id, label, count, Icon }) => <button className={tab === id ? 'selected' : ''} key={id} onClick={() => { setTab(id); setPage(1); }}><Icon size={15} />{label}{count !== undefined && <span>{count}</span>}</button>)}</div>{tab === 'history' ? <><div className="list-toolbar"><h2>每一次练习的记录</h2><SearchBox value={attemptSearch} onChange={setAttemptSearch} placeholder="搜索练习名称" /></div>{attempts.loading ? <Loading /> : attempts.error ? <ErrorNotice message={attempts.error} retry={attempts.refresh} /> : filteredAttempts.length ? <HistoryGroups attempts={filteredAttempts} /> : <Empty title="还没有练习记录" description="选择或创建一套练习卷，开始检验自己的理解。" actions={<a className="button primary" href="#/papers">前往练习卷</a>} />}</> : <><FiltersPanel filters={filters} onChange={value => { setFilters(value); setPage(1); }} />{questions.loading ? <Loading /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <><div className="question-list study-question-list">{questions.data.items.map(question => <QuestionRow question={question} key={question.id} />)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={questions.data.total} onPage={setPage} /></> : <Empty title={tab === 'due' ? '当前没有到期复习' : tab === 'favorite' ? '把想再看的题目收藏起来' : '当前没有错题记录'} description={tab === 'due' ? '在题目详情记录掌握程度，系统会按本次情况安排下次复习。' : tab === 'wrong' ? '提交客观题练习后，错误题目会出现在这里。' : '打开一道题，点击收藏，方便后续回顾。'} actions={<a className="button" href="#/questions">浏览题库</a>} />}</>}<div className="quiet-note"><CalendarCheck2 size={18} /><p>掌握程度使用 0–3 级自评：不会、需要提示、独立回答、能够深入追问。D / L / F 是题目属性，不是学习分数。</p></div></>;
}
