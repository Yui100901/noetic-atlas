import { useEffect, useState } from 'react';
import { CalendarCheck2, ClipboardList, Clock3, History, Star, Target } from 'lucide-react';
import type { Paper } from '../../../shared/models/types';
import type { GlobalLearningSummary, LearningCardSummaries, LearningCardSummary } from '../../../shared/practice/global-learning';
import { href, idPath, request, useResource } from '../../shared/lib/api';
import { ErrorNotice } from '../../shared/ui/components';
import { pointText } from '../../shared/lib/scoring';
import './learning-cards.css';

/** One read-only batch per visible page, including safe cancellation on search. */
export function useLearningCardSummaries(papers: Paper[]) {
  const idsKey = JSON.stringify([...new Set(papers.map(paper => paper.id))]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; items: LearningCardSummary[]; error: string; loading: boolean }>({ key: '', items: [], error: '', loading: true });
  useEffect(() => {
    const controller = new AbortController();
    const paperIds = JSON.parse(idsKey) as string[];
    setResult({ key: idsKey, items: [], error: '', loading: paperIds.length > 0 });
    if (paperIds.length) void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const data = await request<LearningCardSummaries>('/api/learning/card-summaries', { method: 'POST', body: JSON.stringify({ paperIds }), signal: controller.signal });
        if (!controller.signal.aborted) setResult({ key: idsKey, items: data.items, error: '', loading: false });
      } catch (reason) {
        if (!controller.signal.aborted) setResult({ key: idsKey, items: [], error: (reason as Error).message, loading: false });
      }
    });
    return () => controller.abort();
  }, [idsKey, revision]);
  const current = result.key === idsKey;
  return { items: new Map((current ? result.items : []).map(item => [item.paperId, item.counts])), loading: !current || result.loading, error: current ? result.error : '', refresh: () => setRevision(value => value + 1) };
}

const specialSets = [
  { kind: 'wrong', title: '全部错题', description: '汇总题集、随机与单题自测中的错题，保留答题快照与完整来源。', Icon: Target },
  { kind: 'favorite', title: '全部收藏', description: '集中查看收藏的原题，继续阅读、记笔记与巩固理解。', Icon: Star },
  { kind: 'due', title: '待复习', description: '按复习日期汇总到期原题，记录掌握程度，安排下次复习。', Icon: CalendarCheck2 },
] as const;

const paperShortcuts = [
  { kind: 'wrong', tab: 'wrong', label: '错题', accessible: '本集错题', Icon: Target },
  { kind: 'favorite', tab: 'favorite', label: '收藏', accessible: '本集收藏', Icon: Star },
  { kind: 'due', tab: 'review', label: '待复习', accessible: '本集复习', Icon: CalendarCheck2 },
  { kind: 'drafts', tab: 'drafts', label: '草稿', accessible: '本集草稿', Icon: Clock3 },
  { kind: 'submitted', tab: 'history', label: '历史答题', accessible: '本集历史', Icon: History },
] as const;

export function SpecialLearningSets() {
  const summary = useResource<GlobalLearningSummary>('/api/learning/global/summary');
  return <section className="special-learning-sets" aria-label="系统汇总题集">
    <div className="special-learning-heading"><div><h2>随时回顾</h2><p>自动汇总的学习视图，同一题合并展示并保留全部来源。</p></div><span className="badge">系统题集</span></div>
    <div className="special-learning-grid">{specialSets.map(({ kind, title, description, Icon }) => <a className={`special-learning-card special-learning-${kind}`} key={kind} href={`#/learning/${kind}`} aria-label={`打开${title}`}><span className="special-learning-icon"><Icon size={21} /></span><div><h3>{title}</h3><p>{description}</p></div><strong aria-label={`${title}题数`}>{!summary.loading && !summary.error && summary.data ? summary.data.counts[kind].toLocaleString() : '—'}<small>题</small></strong></a>)}</div>
    {summary.error && <ErrorNotice message={`汇总题数暂不可用：${summary.error}`} retry={summary.refresh} />}
  </section>;
}

export function PaperCard({ paper, index, counts, loading }: { paper: Paper; index: number; counts?: LearningCardSummary['counts']; loading: boolean }) {
  const count = (kind: keyof LearningCardSummary['counts']) => !loading && counts ? counts[kind].toLocaleString() : '—';
  return <article className="paper-card" aria-label={`题集：${paper.title}`}>
    <a className="paper-card-main" href={href('papers', paper.id)}><div className="paper-card-top"><span className={`paper-symbol paper-symbol-${index % 3}`}><ClipboardList size={23} /></span><span className={`badge ${paper.archived ? 'status-muted' : ''}`}>{paper.archived ? '已归档' : paper.mode === 'random' ? '标签随机' : '手动选题'}</span></div><h3>{paper.title}</h3><p>{paper.description || '从这套练习开始，检验自己的理解。'}</p><div className="paper-score-label">{paper.practiceKind === 'vocabulary' && <span className="badge">词汇题集 · 双向练习</span>}<span className="badge">{!paper.scoring ? '历史计分' : !paper.scoring.enabled ? '无分练习' : `${paper.scoring.scheme === 'legacy' ? '历史计分 · ' : '计分 · '}${pointText(paper.scoring.totalPoints)} 分`}</span>{paper.scoring?.enabled && <span>客观 {pointText(paper.scoring.objectivePoints)} · 主观 {pointText(paper.scoring.subjectivePoints)}</span>}</div><div className="paper-card-footer"><strong>{paper.questionCount} <small>道题目</small></strong><span>v{paper.version} <span className="dot">·</span> {paper.archived ? '查看与恢复 →' : '查看与学习 →'}</span></div></a>
    <nav className="paper-card-shortcuts" aria-label={`${paper.title}学习快捷入口`} aria-busy={loading}>
      {paperShortcuts.map(({ kind, tab, label, accessible, Icon }) => <a key={kind} href={`#/papers/${idPath(paper.id)}?tab=${tab}`} aria-label={`${accessible}：${paper.title}`}><Icon size={13} /><span>{label}</span><strong title={count(kind)}>{count(kind)}</strong></a>)}
    </nav>
    {!loading && !counts && <p className="paper-card-progress-unavailable">进度暂不可用</p>}
  </article>;
}
