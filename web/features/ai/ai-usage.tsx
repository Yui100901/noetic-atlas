import type { AiDiagnostics } from '../../../shared/ai/ai';
import { useEffect } from 'react';
import type { AiUsageStatistics, AiUsageSummary } from '../../../shared/ai/usage';
import { Empty, ErrorNotice, Loading, Pagination } from '../../shared/ui/components';
import { useResource } from '../../shared/lib/api';
import { usePagination } from '../../shared/lib/pagination';
import './ai-usage.css';

const number = (value: number | null | undefined) =>
  value == null ? '未知' : value.toLocaleString();
const status = { complete: '完整实报', partial: '部分已知', unknown: '未报告用量' };
const coverage = (usage: AiUsageSummary) =>
  `${usage.reportedCalls}/${usage.calls}次调用有用量 · ${status[usage.status]}`;
export function AiUsageInline({ diagnostics }: { diagnostics?: AiDiagnostics }) {
  const usage = diagnostics?.usage;
  return (
    <p className="ai-usage-inline">
      {usage ? (
        <>
          输入 {number(usage.inputTokens)} · 输出 {number(usage.outputTokens)} · 总计{' '}
          {number(usage.totalTokens)} Token <span className="badge">{status[usage.status]}</span>
        </>
      ) : (
        'Token用量未知'
      )}
    </p>
  );
}
export function AiUsageDetail({ diagnostics }: { diagnostics?: AiDiagnostics }) {
  const usage = diagnostics?.usage;
  if (!usage)
    return <p className="muted">此记录未保存供应商Token用量，历史字节数不能换算为Token。</p>;
  return (
    <section className="ai-usage-details" aria-label="本次Token用量">
      <strong>本次Token用量</strong>
      <p className="muted">
        {coverage(usage)}
        {diagnostics?.provider ? ` · ${diagnostics.provider}` : ''}
      </p>
      <dl className="ai-usage-metrics">
        {[
          ['输入', usage.inputTokens],
          ['输出', usage.outputTokens],
          ['供应商总计', usage.totalTokens],
          ['缓存命中输入', usage.cacheReadInputTokens],
          ['缓存未命中输入', usage.cacheMissInputTokens],
          ['缓存写入输入', usage.cacheWriteInputTokens],
          ['推理明细', usage.reasoningTokens],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{number(value as number | null)}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">缓存和推理为供应商报告的明细，不额外加到总计中；缺失字段保留未知。</p>
    </section>
  );
}
export function AiUsageStatisticsCard({
  query,
  kindLabels,
  refreshKey,
}: {
  query: string;
  kindLabels: Record<string, string>;
  refreshKey: number;
}) {
  const resource = useResource<AiUsageStatistics>(`/api/ai/usage${query ? `?${query}` : ''}`);
  const groups = usePagination(resource.data?.groups || [], query);
  useEffect(() => {
    if (refreshKey) resource.refresh();
  }, [refreshKey, resource.refresh]);
  return (
    <section className="ai-usage-summary" aria-label="AI用量统计">
      <div className="card-heading">
        <h3>当前筛选范围的AI用量</h3>
      </div>
      {resource.loading ? (
        <Loading text="正在统计用量…" />
      ) : resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : resource.data ? (
        <>
          <dl className="ai-usage-metrics">
            <div>
              <dt>已知输入Token</dt>
              <dd>{number(resource.data.usage.inputTokens)}</dd>
            </div>
            <div>
              <dt>已知输出Token</dt>
              <dd>{number(resource.data.usage.outputTokens)}</dd>
            </div>
            <div>
              <dt>已知供应商总Token</dt>
              <dd>{number(resource.data.usage.totalTokens)}</dd>
            </div>
            <div>
              <dt>处理记录／调用</dt>
              <dd>
                {resource.data.runs.toLocaleString()}
                <small> / {resource.data.usage.calls.toLocaleString()}次已知调用</small>
              </dd>
            </div>
          </dl>
          <p className="muted">
            {coverage(resource.data.usage)}
            {resource.data.unknownCallRuns
              ? `；另有${resource.data.unknownCallRuns}条历史记录缺少调用明细`
              : ''}
            。{resource.data.failedRuns}条失败，{resource.data.cancelledRuns}
            条取消；已报告用量计入统计。
          </p>
          <details className="ai-usage-groups">
            <summary>按服务、模型和任务查看（{resource.data.groups.length}组）</summary>
            {resource.data.groups.length ? (
              <>
                <div className="ai-usage-table">
                  <table>
                    <thead>
                      <tr>
                        <th>服务／模型／任务</th>
                        <th>记录／调用</th>
                        <th>已知输入</th>
                        <th>已知输出</th>
                        <th>已知总计</th>
                        <th>覆盖</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.items.map((group) => (
                        <tr key={JSON.stringify([group.provider, group.model, group.kind])}>
                          <td>
                            {group.provider === 'unknown'
                              ? '服务未知'
                              : group.provider === 'multiple'
                                ? '多服务'
                                : group.provider}
                            <br />
                            <strong>{group.model}</strong>
                            <br />
                            {kindLabels[group.kind] || group.kind}
                          </td>
                          <td>
                            {group.runs} / {group.usage.calls}
                          </td>
                          <td>{number(group.usage.inputTokens)}</td>
                          <td>{number(group.usage.outputTokens)}</td>
                          <td>{number(group.usage.totalTokens)}</td>
                          <td>
                            {status[group.usage.status]}
                            <br />
                            {group.usage.reportedCalls}/{group.usage.calls}次
                            {group.unknownCallRuns ? `，${group.unknownCallRuns}条未知` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination {...groups} label="AI用量分组" />
              </>
            ) : (
              <Empty title="此范围内没有用量记录" />
            )}
          </details>
          <p className="muted">
            各API和模型的Token口径可能不同；跨模型总计为供应商原始数值之和，请结合分组查看。统计仅包含已保存记录，不补算未知用量。
          </p>
        </>
      ) : null}
    </section>
  );
}
