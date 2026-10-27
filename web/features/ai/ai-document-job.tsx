import { useState } from 'react';
import { Check, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import type { AiDocumentBlock, AiDocumentImportResult, AiDocumentJob } from '../../../shared/ai/ai-document';
import type { QuestionInput } from '../../../shared/models/types';
import { idPath, request, send } from '../../shared/lib/api';
import { usePagination } from '../../shared/lib/pagination';
import { Empty, ErrorNotice, Pagination, SearchBox, useApp } from '../../shared/ui/components';
import { AiProgressPanel, aiFailureMessage, useAiProgress } from './ai-progress';
import { AiDocumentBlockCard, type AiDocumentPreviewEdit } from './ai-document-preview';

const phaseLabels: Record<string, string> = { pending: '待处理', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消' };
export function AiDocumentJobPanel({ job, onChange, onClose, onSettled }: { job: AiDocumentJob; onChange: (job: AiDocumentJob) => void; onClose: () => void; onSettled?: () => void }) {
  const { toast, reload } = useApp(), progress = useAiProgress();
  const [selected, setSelected] = useState<string[]>(job.blocks.map(block => block.id));
  const [search, setSearch] = useState(''), [onlyFailed, setOnlyFailed] = useState(false), [expanded, setExpanded] = useState('');
  const [edits, setEdits] = useState<Record<string, AiDocumentPreviewEdit>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [round, setRound] = useState<{ current: number; total: number; label: string } | null>(null);
  const filtered = job.blocks.filter(block => (!onlyFailed || block.planStatus === 'failed' || block.planStatus === 'cancelled' || block.generationStatus === 'failed' || block.generationStatus === 'cancelled') && `${block.label} ${block.title} ${block.summary} ${block.topics.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const paging = usePagination(filtered, `${job.id}:${search}:${onlyFailed}`);
  const chosen = job.blocks.filter(block => selected.includes(block.id));
  const fresh = chosen.filter(block => block.planStatus === 'completed' && ['pending', 'cancelled', 'running'].includes(block.generationStatus) && !block.importedQuestionIds.length);
  const retry = chosen.filter(block => block.planStatus === 'completed' && block.generationStatus === 'failed' && !block.importedQuestionIds.length);
  const importable = chosen.filter(block => block.generationStatus === 'completed' && !block.importedQuestionIds.length && block.questions.length > 0);
  const refresh = async () => { const value = await request<AiDocumentJob>(`/api/ai/document-jobs/${idPath(job.id)}`); onChange(value); return value; };
  async function process(stage: 'plan' | 'generate', retryFailed = false) {
    const status = (block: AiDocumentBlock) => stage === 'plan' ? block.planStatus : block.generationStatus;
    const targets = chosen.filter(block => !block.importedQuestionIds.length && (stage !== 'generate' || block.planStatus === 'completed') && (retryFailed ? status(block) === 'failed' : ['pending', 'cancelled', 'running'].includes(status(block))));
    if (!targets.length) { setError('请选择符合当前操作的知识块。已成功的批次不会重复提交。'); return; }
    const remaining = job.maxQuestions - job.questionCount;
    const requested = (block: AiDocumentBlock) => block.generationQuestionLimit || job.questionsPerBlock;
    const requiresAllocation = stage === 'generate' && targets.reduce((sum, block) => sum + requested(block), 0) > remaining;
    const allocated = stage === 'generate' ? Math.min(job.questionsPerBlock, Math.floor(remaining / targets.length)) : undefined;
    if (stage === 'generate' && (allocated || 0) < 1) { setError(`选中${targets.length}块至少需要${targets.length}题预算，任务仅剩${remaining}题。请减少选中知识块后继续。`); return; }
    setBusy(true); setError(''); setNotice(''); let latest = job, completedRounds = 0;
    try {
      for (const [index, block] of targets.entries()) {
        setRound({ current: index + 1, total: targets.length, label: block.title || block.label });
        latest = await progress.run<AiDocumentJob>(`/api/ai/document-jobs/${idPath(job.id)}/${stage}`, { blockIds: [block.id], ...(retryFailed || status(block) === 'cancelled' ? { retryFailed: true } : {}), ...(stage === 'generate' ? { questionsPerBlock: requiresAllocation ? Math.min(requested(block), allocated!) : requested(block) } : {}) });
        onChange(latest); completedRounds++;
      }
      const failed = latest.blocks.filter(block => targets.some(target => target.id === block.id) && (stage === 'plan' ? block.planStatus !== 'completed' : block.generationStatus !== 'completed')).length;
      setNotice(`本轮已处理${completedRounds}块，${completedRounds - failed}块成功${failed ? `、${failed}块未完成。下方保留具体原因，可单独重试` : ''}。${stage === 'plan' ? '请根据章节摘要选择需要出题的知识块。' : '预览尚未进入题库，请核对后确认导入。'}`);
    } catch (reason) {
      setError(aiFailureMessage(reason));
      setNotice(`本轮已停止，成功批次保留，可重新打开任务继续。${completedRounds ? `本轮已完成${completedRounds}次分块请求。` : ''}`);
      try { await refresh(); } catch { /* Keep the original operation error. */ }
    } finally { setBusy(false); setRound(null); onSettled?.(); }
  }
  async function importSelected() {
    setError('');
    try {
      const entries = importable.map(block => {
        const edit = edits[block.id];
        const parsed: unknown = edit ? JSON.parse(edit.json) : block.questions;
        if (!Array.isArray(parsed) || parsed.some(question => !question || typeof question !== 'object' || typeof question.title !== 'string' || typeof question.type !== 'string')) throw new Error(`${block.title || block.label}的预览应为题目JSON数组，请先修正。`);
        const questions = edit ? parsed.filter((_, index) => edit.selected.includes(index)) : parsed;
        return { blockId: block.id, questions: questions as QuestionInput[] };
      }).filter(entry => entry.questions.length > 0);
      const count = entries.reduce((sum, entry) => sum + entry.questions.length, 0);
      if (!count) throw new Error('请在已生成知识块中至少选择一道题。');
      if (!confirm(`确认将选中的${count}道题新增到待审核？已导入批次不会再次新增。`)) return;
      setBusy(true); setNotice('');
      const result = await send<AiDocumentImportResult>(`/api/ai/document-jobs/${idPath(job.id)}/import`, 'POST', { confirmed: true, blockIds: entries.map(entry => entry.blockId), questions: entries });
      onChange(result.job); setNotice(`已新增${result.added}道待审核题。题目经过审核后才能正式练习。`); toast(`已新增${result.added}道待审核题`); reload(); onSettled?.();
    } catch (reason) { setError(aiFailureMessage(reason)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('删除此教材任务及保存的提取正文、未导入预览？已经导入的题目和AI处理记录保留。')) return;
    setBusy(true); setError('');
    try { await send(`/api/ai/document-jobs/${idPath(job.id)}`, 'DELETE'); onClose(); toast('教材任务已删除'); }
    catch (reason) { setError(aiFailureMessage(reason)); setBusy(false); }
  }
  return <section className="card ai-tools form-stack ai-document-current" aria-label="教材分批任务">
    <div className="list-toolbar"><div><h2>2. {job.sourceName}</h2><p className="muted">总结{job.plannedBlocks}/{job.blockCount}块 · 生成{job.questionCount}/{job.maxQuestions}题 · 已导入{job.importedCount}题{job.failedBlocks ? ` · ${job.failedBlocks}块有失败` : ''}</p></div><div className="ai-document-actions"><button className="button" disabled={busy} onClick={() => { setError(''); void refresh().catch(reason => setError(aiFailureMessage(reason))); }}><RefreshCw size={15} />刷新</button><button className="button" disabled={busy} onClick={onClose}><X size={15} />收起任务</button><button className="button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />删除任务</button></div></div>
    <p className="muted">每块最多{job.questionsPerBlock}题，总预算{job.maxQuestions}题。选择多块时按剩余预算均摊，材料不足可少于上限。处理一块保存一块，离开后从任务列表继续。</p>
    <div className="ai-document-toolbar"><SearchBox value={search} onChange={setSearch} placeholder="查找章节、知识点或来源" /><label className="check-row"><input type="checkbox" checked={onlyFailed} onChange={event => setOnlyFailed(event.target.checked)} />仅看失败／取消</label></div>
    <div className="ai-document-actions"><button className="button" disabled={busy} onClick={() => setSelected(job.blocks.map(block => block.id))}>选择全部{job.blockCount}块</button><button className="button" disabled={busy} onClick={() => setSelected(filtered.map(block => block.id))}>选择当前筛选结果</button><button className="button" disabled={busy} onClick={() => setSelected([])}>清空选择</button><span className="muted">已选{selected.length}块 · 跨页保留</span></div>
    <div className="ai-document-actions"><button className="button primary" disabled={busy || !chosen.some(block => ['pending', 'cancelled', 'running'].includes(block.planStatus))} onClick={() => void process('plan')}><Sparkles size={15} />AI总结选中知识块</button><button className="button" disabled={busy || !chosen.some(block => block.planStatus === 'failed')} onClick={() => void process('plan', true)}><RefreshCw size={15} />重试失败总结</button><button className="button primary" disabled={busy || !fresh.length} onClick={() => void process('generate')}><Sparkles size={15} />为选中知识块生成题目（{fresh.length}块）</button><button className="button" disabled={busy || !retry.length} onClick={() => void process('generate', true)}><RefreshCw size={15} />重试失败出题（{retry.length}块）</button><button className="button" disabled={busy || !importable.length} onClick={() => void importSelected()}><Check size={15} />确认选中预览到待审核（{importable.length}块）</button></div>
    {fresh.length * job.questionsPerBlock > job.maxQuestions - job.questionCount && <p className="notice">当前剩余预算{job.maxQuestions - job.questionCount}题，将在{fresh.length}个待出题块间均摊，每块最多{Math.min(job.questionsPerBlock, Math.floor((job.maxQuestions - job.questionCount) / Math.max(1, fresh.length)))}题；已成功批次不重复提交。</p>}
    {round && <div className="ai-document-round" role="status"><strong>正在{round.current}/{round.total}轮：{round.label}</strong><progress aria-label="教材分批总进度" max={round.total} value={round.current - 1} /></div>}
    <AiProgressPanel value={progress.progress} cancel={progress.cancel} />
    {error && <ErrorNotice message={error} />}{notice && <div className="notice info" role="status">{notice}{notice.startsWith('已新增') && <a href="#/questions/review">前往待审核</a>}</div>}
    {paging.items.length ? <div className="ai-document-blocks">{paging.items.map(block => <AiDocumentBlockCard key={block.id} block={block} checked={selected.includes(block.id)} disabled={busy} expanded={expanded === block.id} onToggle={() => setExpanded(value => value === block.id ? '' : block.id)} onCheck={checked => setSelected(values => checked ? [...values, block.id] : values.filter(id => id !== block.id))} edit={edits[block.id]} onEdit={value => setEdits(values => ({ ...values, [block.id]: value }))} phaseLabels={phaseLabels} />)}</div> : <Empty title="没有符合条件的知识块" />}
    <Pagination {...paging} label="知识块" />
  </section>;
}
