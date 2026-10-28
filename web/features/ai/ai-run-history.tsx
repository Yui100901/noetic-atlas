import { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AiRun } from '../../../shared/ai/ai';
import type { Paged } from '../../../shared/utils/pagination';
import { idPath, localDate, request, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Loading, Modal, Pagination } from '../../shared/ui/components';
import { AiGradeResultView, AiRunHeading } from './ai-components';
import type { AiGradeResult, AiRunView } from './ai-api';
import { aiFailureMessage } from './ai-progress';

const kindLabels: Record<string, string> = { explain: '补充解析', grade: '作答评价', import: '题目整理 / 教材出题', review: '题目审核', paper_plan: '推荐组题', connection_test: '服务连通性', document_plan: '教材分块总结', document_generate: '教材分批出题', feedback_review: '题目反馈复核', similar_questions: '近似题推荐', question_edit: '题目辅助编辑' };
const statusLabels: Record<string, string> = { completed: '已完成', failed: '失败', cancelled: '已取消', partial: '部分完成', running: '处理中' };

export function AiRunHistory() {
  const [kind, setKind] = useState(() => { const value = new URLSearchParams(window.location.hash.split('?')[1] || '').get('kind') || ''; return Object.hasOwn(kindLabels, value) ? value : ''; }), [status, setStatus] = useState('');
  const [questionId, setQuestionId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('questionId') || '');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const resource = useResource<Paged<AiRun>>(`/api/ai/runs?page=${page}&pageSize=${pageSize}${kind ? `&kind=${kind}` : ''}${status ? `&status=${status}` : ''}${questionId ? `&questionId=${idPath(questionId)}` : ''}`);
  const [selected, setSelected] = useState<AiRun | null>(null), [error, setError] = useState('');
  const view = async (id: string) => {
    setError('');
    try { setSelected(await request<AiRun>(`/api/ai/runs/${idPath(id)}`)); }
    catch (reason) { setError(aiFailureMessage(reason)); }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const id = params.get('run'); if (id) void view(id);
  }, []);
  return <section className="card ai-tools form-stack">
    <div className="list-toolbar"><h2>处理记录</h2><div className="ai-history-filters">
      <select aria-label="AI记录类型" value={kind} onChange={event => { setKind(event.target.value); setPage(1); }}><option value="">全部类型</option>{Object.entries(kindLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select aria-label="AI记录状态" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option><option value="completed">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></select>
      <button className="button" onClick={resource.refresh}><RefreshCw size={15} />刷新</button>
    </div></div>
    {questionId && <div className="list-toolbar"><span className="muted">仅显示题目 {questionId} 的处理记录</span><button className="button" onClick={() => { setQuestionId(''); setPage(1); }}>查看全部题目记录</button></div>}
    <p className="muted">保留成功、失败和取消记录。失败记录说明出错阶段与可用诊断；不会产生可应用的评分或待审题。大文件任务的每次分块处理分别留有记录。</p>
    {error && <ErrorNotice message={error} />}
    {resource.loading ? <Loading /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : resource.data?.items.length ? <div className="ai-history-list">{resource.data.items.map(run => <article className="ai-history-item" key={run.id}>
      <div className="list-toolbar"><div><div className="ai-history-title"><strong>{kindLabels[run.kind] || run.kind}</strong><span className={`badge ai-run-status-${run.status}`}>{statusLabels[run.status] || run.status}</span></div><p className="muted">{run.model} · {localDate(run.createdAt)}{run.batchId ? ` · 分块 ${run.batchId}` : ''}</p>{run.status !== 'completed' && <p className="ai-failure-message"><AlertCircle size={15} />{run.failure.message}</p>}</div><button className="button" onClick={() => void view(run.id)}>{run.status === 'completed' ? '查看结果' : '查看失败详情'}</button></div>
    </article>)}</div> : <Empty title="还没有符合条件的AI处理记录" />}
    <Pagination page={page} pageSize={pageSize} total={resource.data?.total || 0} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="AI记录" />
    {selected && <Modal title={selected.status === 'completed' ? 'AI处理结果' : 'AI处理失败详情'} wide onClose={() => setSelected(null)}>
      <div className="ai-tools form-stack">
        {selected.status === 'completed' ? selected.kind === 'grade' ? <AiGradeResultView run={selected as AiRunView<AiGradeResult>} /> : <><AiRunHeading run={selected} title={kindLabels[selected.kind] || selected.kind} /><pre className="ai-history-result">{JSON.stringify(selected.result, null, 2)}</pre></> : <div className="notice error"><AlertCircle size={18} /><div><strong>{selected.failure.message}</strong><p>错误码：{selected.failure.code} · 阶段：{selected.failure.stage}</p><p>{selected.failure.recommendation || (selected.failure.retryable ? '本次错误允许重试；请检查具体原因后重新发起。' : '请先修改输入、配置或来源条件，再重新发起。')}</p>{selected.failure.jsonLocation && <p>JSON错误位置：{selected.failure.jsonLocation.line ? `第${selected.failure.jsonLocation.line}行` : ''}{selected.failure.jsonLocation.column ? `，第${selected.failure.jsonLocation.column}列` : ''}{selected.failure.jsonLocation.offset !== undefined ? `（偏移${selected.failure.jsonLocation.offset}）` : ''}</p>}{selected.failure.validationIssues?.length ? <ul>{selected.failure.validationIssues.map((issue, index) => <li key={index}>{issue.path || '输出根节点'}：{issue.message}（{issue.rule}）</li>)}</ul> : null}</div></div>}
        {selected.jobId && <a className="button" href={`#/ai?tab=documents&job=${idPath(selected.jobId)}`}>打开所属教材任务{selected.batchId ? ` · ${selected.batchId}` : ''}</a>}
        {selected.feedbackId && <a className="button" href={`#/content-quality?feedbackId=${idPath(selected.feedbackId)}`}>打开所属质量问题</a>}
        {selected.diagnostics && <details className="ai-diagnostics" open={selected.status !== 'completed'}><summary>本次诊断与尝试记录</summary><dl className="ai-diagnostics-grid"><div><dt>阶段</dt><dd>{selected.diagnostics.stage}</dd></div><div><dt>耗时</dt><dd>{(selected.diagnostics.durationMs / 1000).toFixed(1)}秒</dd></div><div><dt>模型调用</dt><dd>{selected.diagnostics.providerCalls}次</dd></div><div><dt>输入／输出</dt><dd>{selected.diagnostics.inputBytes.toLocaleString()}／{selected.diagnostics.outputBytes.toLocaleString()}字节</dd></div>{selected.diagnostics.httpStatus !== undefined && <div><dt>模型HTTP状态</dt><dd>{selected.diagnostics.httpStatus}</dd></div>}{selected.diagnostics.finishReason && <div><dt>输出结束原因</dt><dd>{selected.diagnostics.finishReason}</dd></div>}</dl>{selected.diagnostics.attempts?.length ? <pre className="ai-history-result">{JSON.stringify(selected.diagnostics.attempts, null, 2)}</pre> : null}</details>}
        <p className="muted">诊断只展示安全元数据，不保存密钥、鉴权请求头或模型原始错误正文。</p>
      </div>
    </Modal>}
  </section>;
}
