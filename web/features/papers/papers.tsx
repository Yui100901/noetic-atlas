import { useEffect, useMemo, useState } from 'react';
import { Archive, ArrowLeft, ClipboardList, Clock3, Download, Edit3, Eye, MoreHorizontal, Play, Plus, RotateCcw, Share2, Shuffle, Sparkles, Trash2 } from 'lucide-react';
import type { Attempt, Paper, PaperDetail } from '../../../shared/models/types';
import { href, idPath, localDate, navigate, request, send, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, QuestionMeta, SearchBox, useApp } from '../../shared/ui/components';
import { isSubjectiveType } from '../../../shared/questions/question-utils';
import '../practice/practice-session.css';
import { paperScoring, pointText, ScoringBreakdown } from '../../shared/lib/scoring';
import { ExportButton } from '../../shared/export/export-dialog';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import './paper-organization.css';
import { ShareButton } from '../sharing/sharing';
import { notifyExamState } from '../practice/exam-guard';
import { usePagination } from '../../shared/lib/pagination';
import { normalizePaperContentsContext, paperContentsHref, paperQuestionHref, type PaperContentsContext } from './reader-navigation';
import '../questions/question-viewer.css';
import { PaperLearningWorkspace, RetainedSetHistories } from './paper-learning';
import { PaperCard, SpecialLearningSets, useLearningCardSummaries } from './learning-cards';
import { ActionDropdown } from '../../shared/ui/action-dropdown';
import { VocabularyDirectionFields, vocabularyDirectionLabel, type VocabularyDirection } from './vocabulary-practice';
import { DailyPushCard, useDailyPush } from '../daily-push/daily-push';

export function PapersPage() {
  const { bootstrap } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, refresh } = useResource<Paper[]>(`/api/papers${showArchived ? '?archived=true' : ''}`);
  const { overview: dailyOverview } = useDailyPush();
  // The scheduler can create a set while this page stays mounted. Observe its
  // stable ID, so notification polling/mark-read never causes a reload loop.
  useEffect(() => { if (dailyOverview?.today?.paperId) refresh(); }, [dailyOverview?.today?.paperId, refresh]);
  const [search, setSearch] = useState('');
  const [organization, setOrganization] = useState('all');
  const papers = data?.filter(paper => paper.title.toLowerCase().includes(search.toLowerCase()) && (organization === 'all' || (organization === 'other' ? paper.organization !== 'domain' : organization === 'domain' ? paper.organization === 'domain' : paper.organization === 'domain' && `domain:${paper.domainId}` === organization))) || [];
  const paging = usePagination(papers, `${search}|${organization}|${showArchived}`);
  const cardSummaries = useLearningCardSummaries(paging.items);
  const groups = new Map<string, Paper[]>();
  for (const paper of paging.items) { const key = paper.organization === 'domain' ? `domain:${paper.domainId || ''}` : 'other'; groups.set(key, [...(groups.get(key) || []), paper]); }
  const orderedGroups = [...groups].sort(([left], [right]) => left === 'other' ? 1 : right === 'other' ? -1 : (bootstrap.domains.find(domain => `domain:${domain.id}` === left)?.sortOrder || 0) - (bootstrap.domains.find(domain => `domain:${domain.id}` === right)?.sortOrder || 0));
  return <><PageHeader eyebrow="QUESTION SETS" title="整理成题集，按自己的节奏学习。" description="手动选题、按标签随机选题或让 AI 推荐，将相关题目整理成题集。支持逐题学习、练习、考试、导出与分享。" actions={<><a className="button feature-entry" href="#/ai?tab=paper"><Sparkles size={17} />AI 推荐题集</a><a className="button" href="#/quick"><Shuffle size={16} />随机抽一题</a><a className="button" href="#/papers/new/random"><Shuffle size={16} />随机选题</a><a className="button primary" href="#/papers/new/manual"><Plus size={17} />手动选题</a></>} />
    <DailyPushCard />
    <div className="paper-intro"><div><span className="section-label">按自己的节奏学习</span><p>每份题集内查看错题、复习建议、作答草稿和历史。</p></div><a className="button feature-entry" href="#/quick?tab=history"><Clock3 size={17} />随机与单题自测记录</a></div>
    <SpecialLearningSets />
    <RetainedSetHistories />
    <div className="list-toolbar"><h2>我的题集 <span className="muted">{papers.length}</span></h2><div className="paper-list-tools"><select aria-label="题集组织筛选" value={organization} onChange={event => setOrganization(event.target.value)}><option value="all">全部题集</option><option value="domain">全部领域专项</option>{bootstrap.domains.map(domain => <option value={`domain:${domain.id}`} key={domain.id}>{domain.name}专项</option>)}<option value="other">其他题集</option></select><label className="archive-switch"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示已归档</label><SearchBox value={search} onChange={setSearch} placeholder="查找题集" /></div></div>
    {cardSummaries.error && <div className="paper-card-summary-error"><ErrorNotice message={`题集学习进度暂不可用：${cardSummaries.error}`} retry={cardSummaries.refresh} /></div>}
    {loading ? <Loading /> : error ? <ErrorNotice message={error} retry={refresh} /> : papers.length ? <><div className="paper-groups">{orderedGroups.map(([domainId, items]) => <section className="paper-organization-group" key={domainId}><h2>{domainId === 'other' ? '其他题集' : `${bootstrap.domains.find(domain => `domain:${domain.id}` === domainId)?.name || '未识别领域'}专项`} <span className="muted">{items.length}</span></h2><div className="paper-grid">{items.map((paper, index) => <PaperCard paper={paper} index={index} counts={cardSummaries.items.get(paper.id)} loading={cardSummaries.loading} key={paper.id} />)}</div></section>)}</div><Pagination {...paging} label="题集" /></> : <Empty title={search || organization !== 'all' ? '没有符合条件的题集' : '创建第一套题集'} description="挑选自己的薄弱点，或按标签生成一套练习。" actions={<a className="button primary" href="#/papers/new/manual"><Plus size={16} />创建题集</a>} />}</>;
}

export function PaperDetailPage({ id, initialTab = 'content', initialContents = normalizePaperContentsContext() }: { id: string; initialTab?: string; initialContents?: PaperContentsContext }) {
  const { data: paper, loading, error, refresh } = useResource<PaperDetail>(`/api/papers/${idPath(id)}?summary=true`);
  const { toast, reload, bootstrap } = useApp(); const settings = bootstrap.settings || DEFAULT_SETTINGS; const [busy, setBusy] = useState(false); const [drafts, setDrafts] = useState<Attempt[] | null>(null);
  const [vocabularyDirection, setVocabularyDirection] = useState<VocabularyDirection>('word_to_meaning');
  const [practiceSetup, setPracticeSetup] = useState(false); const [questionCount, setQuestionCount] = useState(20); const [selection, setSelection] = useState<'ordered' | 'random'>('random');
  const [examSetup, setExamSetup] = useState(false); const [durationMinutes, setDurationMinutes] = useState((settings as any).examDurationMinutes || 120);
  const [transfer, setTransfer] = useState<'share' | 'export' | null>(null);
  useEffect(() => { setTransfer(null); setVocabularyDirection('word_to_meaning'); setDrafts(null); setPracticeSetup(false); setExamSetup(false); }, [id]);
  const startNew = async (mode: 'practice' | 'exam' = 'practice') => { setBusy(true); try { const attempt = await send<Attempt>(`/api/papers/${idPath(id)}/attempts`, 'POST', { mode, ...(['vocabulary','concept'].includes(paper?.practiceKind || 'standard') ? { vocabularyDirection } : {}), ...(mode === 'exam' ? { durationMinutes } : {}), ...((paper?.answerCount ?? paper?.questions.length ?? 0) > 500 ? { count: questionCount, selection } : {}) }); setDrafts(null); setExamSetup(false); setPracticeSetup(false); notifyExamState(attempt); navigate('attempts', attempt.id); } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); } };
  const openNewPractice = async () => { setDrafts(null); if (['vocabulary','concept'].includes(paper?.practiceKind || 'standard') || (paper?.answerCount ?? paper?.questions.length ?? 0) > 500) { setQuestionCount(Math.min(20, paper?.questionCount || 20)); setSelection('random'); setPracticeSetup(true); } else await startNew(); };
  const start = async () => { setBusy(true); try { const saved = await request<Attempt[]>(`/api/papers/${idPath(id)}/drafts`); const practiceDrafts = saved.filter(a => a.practiceMode !== 'exam'); if (practiceDrafts.length) setDrafts([...practiceDrafts].sort((a, b) => (b.updatedAt || b.startedAt).localeCompare(a.updatedAt || a.startedAt)).slice(0, settings.maxDraftsPerPaper)); else await openNewPractice(); } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); } };
  const archive = async () => { if (!confirm('确定归档这套题集？历史作答仍会保留。')) return; setBusy(true); try { await send(`/api/papers/${idPath(id)}`, 'DELETE'); toast('题集已归档'); reload(); navigate('papers'); } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); } };
  const restore = async () => { if(!confirm('恢复这份题集以便继续练习？首次恢复旧集合时将采用已审核题目，已有作答记录保持不变。'))return;setBusy(true);try{await send(`/api/papers/${idPath(id)}/restore`,'POST',{confirmed:true});toast('题集已恢复');refresh();reload();}catch(error){toast((error as Error).message,true);}finally{setBusy(false);} };
  const remove = async () => { if (!confirm('永久删除这套题集？题集无法恢复，已保存的作答快照继续保留。')) return; setBusy(true); try { await send(`/api/papers/${idPath(id)}?permanent=true`, 'DELETE'); toast('题集已删除，可在题集列表的「已删除题集的历史」中继续复盘'); reload(); navigate('papers'); } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); } };
  if (loading) return <Loading />; if (error || !paper) return <ErrorNotice message={error || '题集不存在'} retry={refresh} />;
  const vocabularySet = ['vocabulary','concept'].includes(paper.practiceKind || 'standard');
  const scoring = paperScoring(paper); const largeSet = (paper.answerCount ?? paper.questions.length) > 500;
  const validCount = Number.isInteger(questionCount) && questionCount >= 1 && questionCount <= Math.min(500, paper.questionCount);
  const samplingFields = <><p className="muted">本题集有 {paper.questionCount.toLocaleString()} 个选题单位、{(paper.answerCount ?? paper.questions.length).toLocaleString()} 个作答项。请指定本次范围；每次最多 500 个作答项，组合题保留完整材料和小题。</p><Field label="本次选题数量"><input type="number" min={1} max={Math.min(500, paper.questionCount)} step={1} value={questionCount} onChange={event => setQuestionCount(Number(event.target.value))} /></Field><Field label="选题方式"><select value={selection} onChange={event => setSelection(event.target.value as 'ordered' | 'random')}><option value="random">从题集中随机抽题</option><option value="ordered">按题集顺序从头选题</option></select></Field><p className="muted">组合题按一组选题，全部小题一并加入；如超过 500 个作答项，请减少选题数量。本次练习保留选中题目和分值快照。</p></>;
  return <><a className="back-link" href="#/papers"><ArrowLeft size={15} />返回题集</a><PageHeader eyebrow={`QUESTION SET · V${paper.version}`} title={paper.title} description={paper.description || `${paper.questionCount} 道题目，按自己的节奏完成。`} actions={<div className="paper-detail-actions" role="group" aria-label="题集操作">
    <ActionDropdown label="导出与分享" icon={<Share2 size={16} />} disabled={busy} items={[
      { id: 'export', label: '导出题集', icon: <Download size={16} />, onSelect: () => setTransfer('export') },
      { id: 'share', label: '分享题集', icon: <Share2 size={16} />, onSelect: () => setTransfer('share') },
    ]} />
    <ActionDropdown label="题集管理" icon={<MoreHorizontal size={17} />} disabled={busy} items={[
      { id: 'edit', label: paper.archived ? '恢复并调整' : '调整题目与分值', icon: <Edit3 size={16} />, href: `#/papers/${idPath(id)}/edit` },
      paper.archived
        ? { id: 'restore', label: '恢复题集', icon: <RotateCcw size={16} />, onSelect: () => void restore() }
        : { id: 'archive', label: '归档题集', icon: <Archive size={16} />, onSelect: () => void archive() },
      { id: 'delete', label: '永久删除', icon: <Trash2 size={16} />, danger: true, separatorBefore: true, onSelect: () => void remove() },
    ]} />
    <ActionDropdown label={busy ? '正在准备…' : '开始练习'} triggerLabel="选择练习模式" icon={<Play size={16} />} primary disabled={busy || paper.archived} primaryAction={() => void start()} items={[
      { id: 'practice', label: '普通练习', icon: <Play size={16} />, onSelect: () => void start() },
      { id: 'exam', label: '考试模式', icon: <Clock3 size={16} />, onSelect: () => { setQuestionCount(Math.min(100, paper.questionCount)); setSelection('random'); setExamSetup(true); } },
    ]} />
  </div>} />
    <ExportButton paperId={id} open={transfer === 'export'} onOpenChange={open => setTransfer(open ? 'export' : null)} hideTrigger />
    <ShareButton kind="paper" id={id} open={transfer === 'share'} onOpenChange={open => setTransfer(open ? 'share' : null)} hideTrigger />
    {paper.archived && <div className="notice info">这份题集已归档，全部成员审核发布后，可在顶部「题集管理 → 恢复题集」中继续练习。</div>}<div className="paper-organization-label">{vocabularySet && <span className="badge">{paper.practiceKind === 'concept' ? '概念题集 · 双向练习' : '词汇题集 · 双向练习'}</span>}<span className="badge">{paper.organization === 'domain' ? `${bootstrap.domains.find(domain => domain.id === paper.domainId)?.name || '未识别领域'}专项` : '其他题集'}</span></div><section className="card paper-scoring-detail"><ScoringBreakdown scoring={scoring} questionCount={paper.questionCount} />{scoring.enabled && paper.mode === 'random' && <p className="scoring-help">目标客观占比 {pointText(scoring.objectivePercent)}%，实际客观占比 {pointText(scoring.actualObjectivePercent)}%。题量与分值已固定，开始练习时保留本题集快照。</p>}{scoring.scheme === 'legacy' && <p className="scoring-help">这份历史题集采用历史分值：单选 / 判断 1 分、多选 2 分、主观 3 分。修改会生成新版本，不重算已有作答。</p>}</section>
    {practiceSetup && <Modal title={vocabularySet ? (paper.practiceKind === "concept" ? "开始概念练习" : "开始词汇练习") : "选择本次练习范围"} onClose={() => { if (!busy) setPracticeSetup(false); }}>{vocabularySet && <VocabularyDirectionFields kind={paper.practiceKind} value={vocabularyDirection} onChange={setVocabularyDirection} />}{largeSet && samplingFields}<div className="form-actions"><button className="button" disabled={busy} onClick={() => setPracticeSetup(false)}>取消</button><button className="button primary" disabled={busy || largeSet && !validCount} onClick={() => void startNew()}><Play size={16} />开始本次练习</button></div></Modal>}
    {examSetup && <Modal title="开始限时考试" onClose={() => { if (!busy) setExamSetup(false); }}><p className="muted">开始后不能切换其他功能。计时在刷新、关闭页面或应用进入后台时仍然继续；到时按已保存答案自动交卷。</p>{vocabularySet && <VocabularyDirectionFields kind={paper.practiceKind} value={vocabularyDirection} onChange={setVocabularyDirection} />}{largeSet && samplingFields}<Field label="考试时长（分钟）"><input type="number" min={1} max={1440} step={1} value={durationMinutes} onChange={event => setDurationMinutes(Number(event.target.value))} /></Field><p className="muted">默认 {(settings as any).examDurationMinutes || 120} 分钟，可在系统配置中调整。已保存的题集与考试记录各自独立。</p><div className="form-actions"><button className="button" disabled={busy} onClick={() => setExamSetup(false)}>取消</button><button className="button primary" disabled={busy || largeSet && !validCount || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440} onClick={() => void startNew('exam')}><Play size={16} />开始考试</button></div></Modal>}
    {drafts && <Modal title="继续之前的作答？" onClose={() => setDrafts(null)}><p className="muted">这份题集最多保留最近 {settings.maxDraftsPerPaper} 份草稿。继续作答会沿用该草稿的练习方向并更新原草稿。需要更换方向时，请选择“重新答题”。</p><div className="draft-options">{drafts.map((draft, index) => { const answered = draft.questions.filter(question => { const value = draft.answers[question.id]?.value; return Array.isArray(value) ? value.some(item => item.trim()) : !!value?.trim(); }).length; return <button className="draft-option" key={draft.id} disabled={busy} onClick={() => { setDrafts(null); navigate('attempts', draft.id); }}><Clock3 size={20} /><span><strong>草稿 {index + 1} · 已答 {answered}/{draft.questions.length} 题</strong><small>{vocabularyDirectionLabel(draft.vocabularyDirection, draft.practiceKind) || '原题练习'} · 最后保存 {localDate(draft.updatedAt || draft.startedAt)}</small><small>v{draft.paperVersion}{draft.paperVersion !== paper.version ? ` · 历史版本，当前题集为 v${paper.version}，继续使用原题快照` : ' · 当前版本'}</small></span><span className="text-button">继续作答 →</span></button>; })}</div><div className="draft-modal-footer"><span className="muted">重新答题将新建草稿；超出 {settings.maxDraftsPerPaper} 份时删除最早的草稿，已提交记录继续保留。</span><button className="button primary" disabled={busy} onClick={() => void openNewPractice()}><Plus size={16} />重新答题</button></div></Modal>}
    <div className="paper-summary"><div><strong>{paper.questionCount}</strong><span>个选题单位 · {paper.answerCount ?? paper.questions.length} 个作答项</span></div><div><strong>{paper.questions.filter(question => !isSubjectiveType(question.type)).length}</strong><span>{scoring.enabled ? '客观题 · 提交后自动判分' : '客观题 · 提交后核对正误'}</span></div><div><strong>{paper.questions.filter(question => isSubjectiveType(question.type)).length}</strong><span>{scoring.enabled ? '主观题 · 交卷后人工阅卷' : '主观题 · 按解析自测掌握度'}</span></div><div><span>最近更新</span><p>{localDate(paper.updatedAt)}</p></div></div>
    <PaperLearningWorkspace paperId={id} initialTab={initialTab}>
      <div className="notice info"><ClipboardList size={17} />点击题目可在当前题集中查看完整内容与解析，使用上一题、下一题连续学习。{scoring.enabled ? '练习或考试提交后，客观题自动判分。' : '也可通过无分练习记录正误和掌握程度。'}</div>
      <QuestionSetContents paper={paper} initial={initialContents} />
    </PaperLearningWorkspace>
    </>;
}

/** Keep list state in the URL before leaving for the independent reader. */
function QuestionSetContents({ paper, initial }: { paper: PaperDetail; initial: PaperContentsContext }) {
  const [search, setSearch] = useState(initial.search);
  const [page, setPage] = useState(initial.page), [pageSize, setPageSize] = useState(initial.pageSize);
  const visible = useMemo(() => { const term = search.trim().toLowerCase(); return term ? paper.questions.filter(question => `${question.title} ${question.id}`.toLowerCase().includes(term)) : paper.questions; }, [paper.questions, search]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize)));
  const context = { search, page: safePage, pageSize };
  const remember = (value: PaperContentsContext = context) => { window.history.replaceState(window.history.state, '', paperContentsHref(paper.id, value)); };
  const paging = { page: safePage, pageSize, total: visible.length,
    items: visible.slice((safePage - 1) * pageSize, safePage * pageSize),
    onPage: (value: number) => { setPage(value); remember({ ...context, page: value }); },
    onPageSize: (value: number) => { setPageSize(value); setPage(1); remember({ ...context, page: 1, pageSize: value }); },
  };
  const scoring = paperScoring(paper);
  return <section className="question-set-contents"><div className="list-toolbar question-set-question-tools"><h2>题集内容 <span className="muted">{visible.length.toLocaleString()}</span></h2><SearchBox value={search} onChange={value => { setSearch(value); setPage(1); remember({ ...context, search: value, page: 1 }); }} placeholder="在本题集中查找标题或题号" /></div>
    <div className="question-set-question-list">{paging.items.map((question, localIndex) => { const index = (paging.page - 1) * paging.pageSize + localIndex; const readerHref = paperQuestionHref(paper.id, question.id, context); return <section className="card question-set-question-row" key={question.id}><div className="exam-heading"><span className="number-label">{String(index + 1).padStart(2, '0')}</span><div><QuestionMeta question={question} /><a className="text-button question-set-question-title" href={readerHref} onClick={() => remember()}>{question.title}</a>{question.groupTitle && <p className="muted">共用材料 · {question.groupTitle}</p>}{scoring.enabled && <span className="question-points">本题 {pointText(scoring.questionPoints[question.id] ?? question.points ?? 0)} 分</span>}</div><a className="button" aria-label={`查看题目：${question.title}`} href={readerHref} onClick={() => remember()}><Eye size={15} />查看题目</a></div></section>; })}</div>
    {!visible.length && <Empty title="没有符合条件的题目" description="尝试其他标题或题号。" />}<Pagination {...paging} label="题集题目" />
  </section>;
}
