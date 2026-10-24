import { useState } from 'react';
import { ArrowLeft, Shuffle } from 'lucide-react';
import type { Attempt, PaperFilters } from '../../../shared/models/types';
import { send } from '../../shared/lib/api';
import { Empty, ErrorNotice, PageHeader, useApp } from '../../shared/ui/components';
import { AttemptPage } from './attempt';
import { RandomFilters } from '../papers/paper-editor';
import './practice-session.css';
import { normalizePaperFilters } from '../../shared/lib/learning-filters';
import { ContextLearningPanel } from './context-learning';

export function QuickPracticePage({ initialTab }: { initialTab?: string }) {
  const [filters, setFilters] = useState<PaperFilters>({ tagIds: [], tagMode: 'all', types: [], collection: 'all', difficultyMin: 1, difficultyMax: 4, frequencyMin: 0 });
  const [attemptId, setAttemptId] = useState(''); const [sourceQuestionId, setSourceQuestionId] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [expanded, setExpanded] = useState(true);
  const { reload } = useApp(); const [recordsRevision, setRecordsRevision] = useState(0);
  const refreshRecords = () => setRecordsRevision(value => value + 1);
  const set = <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => setFilters(old => ({ ...old, [key]: value, ...(key === 'domainId' ? { categoryId: '' } : {}) }));
  const draw = async () => {
    if ((filters.difficultyMin || 1) > (filters.difficultyMax || 4)) { setError('最低难度不能高于最高难度。'); return; }
    setBusy(true); setError('');
    try { const attempt = await send<Attempt>('/api/quick-practice', 'POST', { filters: normalizePaperFilters(filters), ...(sourceQuestionId ? { excludeQuestionId: sourceQuestionId } : {}) }); setAttemptId(attempt.id); setSourceQuestionId(attempt.questions[0]?.sourceQuestionId || ''); setExpanded(false); refreshRecords(); reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <div className="quick-practice-page"><a className="back-link" href="#/papers"><ArrowLeft size={15} />返回题集与练习</a><PageHeader eyebrow="ONE QUESTION AT A TIME" title="随机一题，检验一个知识点。" description="按领域、分类与标签取交集，只抽取已发布题目。组合题会连同材料与小题一起出现。无需创建题集。" actions={<button className="button primary" disabled={busy} onClick={() => void draw()}><Shuffle size={16} />{busy ? '正在抽题…' : attemptId ? '重新随机一题' : '随机抽一题'}</button>} />
    <section className="card quick-filter-card"><div className="list-toolbar"><div><h2>抽题范围</h2><p className="muted">筛选条件会保留，不会在题量不足时自动放宽。</p></div><button className="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起筛选' : '调整筛选'}</button></div>{expanded && <div className="form-stack"><RandomFilters random={filters} set={set} /></div>}</section>
    {error && <ErrorNotice message={error} />}
    {attemptId ? <section className="quick-current-attempt" data-attempt-id={attemptId}><AttemptPage key={attemptId} id={attemptId} embedded onChanged={refreshRecords} /></section> : <Empty title="从一题开始" description="设置范围后点击「随机抽一题」开始作答，提交后核对答案。笔记和学习进度可在查阅题目时整理。" />}
    <ContextLearningPanel source="quick" initialTab={initialTab} refreshKey={recordsRevision} />
    <div className="quiet-note"><p>随机答题与单题自测的草稿、历史、错题及复习记录集中在本页。重新抽题会开始一份新的自测草稿。</p></div>
  </div>;
}
