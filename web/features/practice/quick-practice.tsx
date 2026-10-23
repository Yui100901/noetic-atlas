import { useState } from 'react';
import { ArrowLeft, Clock3, Shuffle } from 'lucide-react';
import type { Attempt, PaperFilters } from '../../../shared/models/types';
import { localDate, send, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, PageHeader, useApp } from '../../shared/ui/components';
import { AttemptPage } from './attempt';
import { RandomFilters } from '../papers/paper-editor';
import './practice-session.css';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import { normalizePaperFilters } from '../../shared/lib/learning-filters';

export function QuickPracticePage() {
  const [filters, setFilters] = useState<PaperFilters>({ tagIds: [], tagMode: 'all', types: [], collection: 'all', difficultyMin: 1, difficultyMax: 4, frequencyMin: 0 });
  const [attemptId, setAttemptId] = useState(''); const [sourceQuestionId, setSourceQuestionId] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [expanded, setExpanded] = useState(true);
  const drafts = useResource<Attempt[]>('/api/attempts?source=quick&status=in_progress'); const { reload, bootstrap } = useApp(); const settings = bootstrap.settings || DEFAULT_SETTINGS;
  const set = <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => setFilters(old => ({ ...old, [key]: value, ...(key === 'domainId' ? { categoryId: '' } : {}) }));
  const draw = async () => {
    if ((filters.difficultyMin || 1) > (filters.difficultyMax || 4)) { setError('最低难度不能高于最高难度。'); return; }
    setBusy(true); setError('');
    try { const attempt = await send<Attempt>('/api/quick-practice', 'POST', { filters: normalizePaperFilters(filters), ...(sourceQuestionId ? { excludeQuestionId: sourceQuestionId } : {}) }); setAttemptId(attempt.id); setSourceQuestionId(attempt.questions[0]?.sourceQuestionId || ''); setExpanded(false); drafts.refresh(); reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <div className="quick-practice-page"><a className="back-link" href="#/papers"><ArrowLeft size={15} />返回练习工作室</a><PageHeader eyebrow="ONE QUESTION AT A TIME" title="随机一题，检验一个知识点。" description="按领域、分类与标签取交集，只抽取已发布题目。组合题会连同材料与小题一起出现。无需创建练习卷。" actions={<button className="button primary" disabled={busy} onClick={() => void draw()}><Shuffle size={16} />{busy ? '正在抽题…' : attemptId ? '重新随机一题' : '随机抽一题'}</button>} />
    <section className="card quick-filter-card"><div className="list-toolbar"><div><h2>抽题范围</h2><p className="muted">筛选条件会保留，不会在题量不足时自动放宽。</p></div><button className="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起筛选' : '调整筛选'}</button></div>{expanded && <div className="form-stack"><RandomFilters random={filters} set={set} /></div>}</section>
    {error && <ErrorNotice message={error} />}
    {!attemptId && drafts.data && drafts.data.length > 0 && <section className="card quick-drafts"><h2><Clock3 size={18} />继续最近的随机自测</h2><div className="draft-options">{drafts.data.slice(0, settings.maxQuickDrafts).map(attempt => <button key={attempt.id} className="draft-option" onClick={() => { setAttemptId(attempt.id); setSourceQuestionId(attempt.questions[0]?.sourceQuestionId || ''); }}><Clock3 size={18} /><span><strong>{attempt.paperTitle}</strong><small>最后保存 {localDate(attempt.updatedAt || attempt.startedAt)}</small></span><span className="text-button">继续 →</span></button>)}</div><p className="muted">随机自测独立保留最近 {settings.maxQuickDrafts} 份草稿，与各练习卷草稿分别管理。</p></section>}
    {attemptId ? <section className="quick-current-attempt" data-attempt-id={attemptId}><AttemptPage key={attemptId} id={attemptId} embedded /></section> : <Empty title="从一题开始" description="设置范围后点击「随机抽一题」。可以直接作答、先看解析，也可以收藏、记笔记或记录掌握程度。" />}
    <div className="quiet-note"><p>随机答题的历史集中在 <a href="#/study?tab=history">学习记录 → 练习历史</a>。已提交记录保留；重新抽题会开始一份新的自测草稿。</p></div>
  </div>;
}
