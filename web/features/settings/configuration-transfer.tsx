import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { ConfigurationChange, ConfigurationExport, ConfigurationImportResult, ConfigurationPreview } from '../../../shared/models/configuration';
import { THEME_LABELS, type Theme } from '../../../shared/models/settings';
import { typeLabels, type QuestionType } from '../../../shared/models/types';
import { ApiError, request, send } from '../../shared/lib/api';
import { ErrorNotice, useApp } from '../../shared/ui/components';
import { saveGeneratedFile } from '@platform';
import './configuration-transfer.css';

const labels: Record<string, string> = {
  theme:'外观主题',
  maxDraftsPerPaper:'每卷草稿上限', maxQuickDrafts:'随机自测草稿上限', maxPaperDrafts:'组题草稿上限',
  examDurationMinutes:'默认考试时长（分钟）', maxHistoryPerPaper:'每卷历史上限', maxQuickHistory:'随机自测历史上限', maxQuestionHistory:'每题完整作答历史上限',
  randomQuestionCount:'默认随机题量', scoringEnabledByDefault:'默认计分', randomTotalPoints:'默认总分',
  objectivePercent:'客观题比例（%）', pointsByType:'题型分值', reviewIntervalsDays:'复习间隔（天）',
  autosaveDebounceMs:'自动保存等待（毫秒）', maxDocumentMiB:'资料上限（MiB）', maxImageMiB:'图片上限（MiB）',
  enabled:'启用AI', baseUrl:'AI接口地址', model:'模型', supportsImages:'模型支持图片', sendImages:'发送图片',
  timeoutSeconds:'请求超时（秒）', maxTokens:'最大输出Token数',
};
function display(value: unknown, key?: string): string {
  if (key === 'theme' && typeof value === 'string' && Object.hasOwn(THEME_LABELS, value)) return THEME_LABELS[value as Theme];
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === '') return '未设置';
  if (Array.isArray(value)) return value.map(item => display(item)).join('、');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${typeLabels[key as QuestionType] || key} ${display(item)}`).join('；');
  return String(value ?? '无');
}
function Changes({ title, changes }: { title: string; changes: ConfigurationChange[] }) {
  return <><h3>{title}</h3>{changes.length ? <div className="table-scroll"><table className="configuration-values"><thead><tr><th>设置</th><th>当前值</th><th>导入值</th></tr></thead><tbody>{changes.map(change => <tr key={change.key}><td>{labels[change.key] || change.key}</td><td>{display(change.before, change.key)}</td><td>{display(change.after, change.key)}</td></tr>)}</tbody></table></div> : <p className="muted">没有差异。</p>}</>;
}

export function ConfigurationTransfer() {
  const { reload, toast } = useApp(); const inputRef = useRef<HTMLInputElement>(null);
  const [includeAi, setIncludeAi] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [data, setData] = useState<unknown>(null), [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null), [confirmedRetention, setConfirmedRetention] = useState(false);
  const [done, setDone] = useState(false);
  const exportConfiguration = async () => {
    setBusy(true); setError('');
    try {
      const bundle = await request<ConfigurationExport>(`/api/settings/export?includeAi=${includeAi}`);
      await saveGeneratedFile('认知星图-配置.json', new TextEncoder().encode(JSON.stringify(bundle, null, 2) + '\n'), 'application/json');
      toast('配置已导出，不含API密钥');
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };
  const inspect = async (value: unknown) => {
    const result = await send<ConfigurationPreview>('/api/settings/import/preview', 'POST', { data: value });
    setPreview(result); setConfirmedRetention(false);
  };
  const load = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError(''); setDone(false); setPreview(null); setData(null); setFilename(file.name);
    try {
      if (file.size > 1024 * 1024) throw new Error('配置文件最多1 MiB；完整学习备份请使用下方数据迁移入口。');
      const value: unknown = JSON.parse(await file.text()); setData(value); await inspect(value);
    } catch (reason) { setError(reason instanceof SyntaxError ? '配置JSON无法解析，请检查文件格式。' : (reason as Error).message); }
    finally { setBusy(false); }
  };
  const inspectAgain = async () => {
    setBusy(true); setError('');
    try { await inspect(data); } catch (reason) { setPreview(null); setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      await send<ConfigurationImportResult>('/api/settings/import', 'POST', { data, fingerprint: preview.fingerprint, confirmed: true, ...(confirmedRetention ? { confirmedRetention: true } : {}) });
      setData(null); setPreview(null); setDone(true); reload(); toast('配置导入完成');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) { setPreview(null); setConfirmedRetention(false); }
      setError((reason as Error).message);
    } finally { setBusy(false); }
  };
  return <section className="card configuration-transfer" aria-label="配置迁移"><div className="configuration-heading"><div><h2>配置迁移</h2><p className="muted">只迁移偏好和默认规则，无需复制题库。API密钥不会进入配置文件。</p></div><div className="action-row"><button className="button" disabled={busy} onClick={() => void exportConfiguration()}><Download size={16} />导出配置</button><button className="button" disabled={busy} onClick={() => { if (inputRef.current) inputRef.current.value = ''; inputRef.current?.click(); }}><Upload size={16} />导入配置文件</button></div></div>
    <label className="check-row"><input type="checkbox" disabled={busy} checked={includeAi} onChange={event => setIncludeAi(event.target.checked)} />导出时包含AI端点、模型和请求参数</label>
    <p className="muted">配置导入可以覆盖本机自定义设置；题目和笔记保留。导入前会展示差异，超限记录清理需另行确认。AI接口改变时会清除目标设备旧密钥。</p>
    <input ref={inputRef} type="file" className="sr-only" aria-label="选择配置JSON文件" accept=".json,application/json" disabled={busy} onChange={event => void load(event.target.files?.[0])} />
    {error && <ErrorNotice message={error} />}{busy && <p role="status">正在处理配置…</p>}
    {done && <div className="notice success" role="status">配置已导入。可切换到“学习与练习”或“AI辅助”查看最新设置。</div>}
    {data !== null && !preview && !busy && <button className="button" onClick={() => void inspectAgain()}>重新预览配置</button>}
    {preview && <div className="configuration-preview"><h3>配置导入预览：{filename}</h3><Changes title="常规配置差异" changes={preview.systemChanges} /><Changes title="AI配置差异" changes={preview.aiChanges} />
      <p>{preview.aiKey.message}</p>{preview.warnings.length > 0 && <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {preview.retention.total > 0 ? <div className="notice warning"><div><p>此配置将清理{preview.retention.drafts}份作答草稿、{preview.retention.history}份已交整卷历史、{preview.retention.authoring || 0}份组题草稿{preview.retention.questionHistory ? `、${preview.retention.questionHistory}份单题详细记录` : ''}，共{preview.retention.total}份记录。单题详细记录清理后，累计作答统计和仍保留的整卷继续保留。可先导出完整备份。</p><label className="check-row"><input type="checkbox" checked={confirmedRetention} disabled={busy} onChange={event => setConfirmedRetention(event.target.checked)} />我确认应用配置并清理上述超限记录</label></div></div> : <p className="muted">不会清理现有草稿与练习历史。</p>}
      <div className="form-actions"><button className="button" disabled={busy} onClick={() => { setData(null); setPreview(null); setError(''); }}>取消导入</button><button className="button primary" disabled={busy || preview.retention.total > 0 && !confirmedRetention} onClick={() => void apply()}>确认应用配置</button></div>
    </div>}
  </section>;
}
