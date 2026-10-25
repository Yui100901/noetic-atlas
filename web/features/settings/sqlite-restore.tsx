import { useEffect, useRef, useState } from 'react';
import { Database, FolderInput, HardDriveDownload, Upload } from 'lucide-react';
import { nativeConfirmSQLiteRestore, nativeDownloadRecoveryBackup, nativeLatestRecoveryBackup, nativePreviewSQLiteRestore } from '@platform';
import type { SQLiteRecoveryBackup, SQLiteRestorePreview } from '../../../shared/models/sqlite-restore';
import { ErrorNotice } from '../../shared/ui/components';
import './sqlite-restore.css';

const labels: Record<string, string> = { questions: '题目', papers: '题集', documents: '资料', assets: '图片/PDF', attempts: '作答历史', learning_results: '独立学习结果', question_history: '单题历史', study: '整题学习记录', study_parts: '小题学习记录', reviews: '复习记录', domains: '领域', categories: '分类', tags: '标签', paper_drafts: '组题草稿', document_drafts: '资料编辑草稿', settings: '系统配置', ai_settings: 'AI 配置', ai_runs: 'AI 分析历史' };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
export function SQLiteRestore() {
  const input = useRef<HTMLInputElement>(null), generation = useRef(0);
  const [preview, setPreview] = useState<SQLiteRestorePreview | null>(null);
  const [backup, setBackup] = useState<SQLiteRecoveryBackup | null>(null);
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { void nativeLatestRecoveryBackup().then(value => setBackup(value || null)).catch(reason => setError(reason.message)); return () => { generation.current++; }; }, []);
  async function select(file?: File) {
    if (!file) return;
    const selected = ++generation.current; setPreview(null); setAcknowledged(false); setError(''); setBusy(true);
    try { const value = await nativePreviewSQLiteRestore(file); if (selected === generation.current) setPreview(value); }
    catch (reason) { if (selected === generation.current) setError((reason as Error).message); }
    finally { if (selected === generation.current) setBusy(false); }
  }
  async function restore() {
    if (!preview || !acknowledged) return;
    setBusy(true); setError('');
    try {
      await nativeConfirmSQLiteRestore(preview.token);
      // Clear all React/query/editor state and the exam guard together. The new
      // runtime opens the committed file; no old page can save stale draft data.
      window.location.reload();
    } catch (reason) {
      setPreview(null); setAcknowledged(false); setError((reason as Error).message);
      try { setBackup(await nativeLatestRecoveryBackup() || null); } catch { /* Preserve the restore failure message. */ }
      setBusy(false);
    }
  }
  async function exportBackup() { if (!backup) return; setBusy(true); setError(''); try { await nativeDownloadRecoveryBackup(backup.id); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }
  return <section className="card import-card" aria-label="SQLite 完整恢复">
    <div className="import-heading"><Database size={23} /><div><h2>从 SQLite 备份完整恢复</h2><p>用备份整体替换本机内容和学习数据。先检查文件与数据引用并展示预览，确认后保留独立的恢复前副本；保存失败会撤销替换。</p></div></div>
    <input ref={input} type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/octet-stream" className="sr-only" aria-label="选择 SQLite 数据库备份" disabled={busy} onChange={event => void select(event.target.files?.[0])} />
    <button className="import-dropzone" type="button" disabled={busy} onClick={() => { if (input.current) input.current.value = ''; input.current?.click(); }}><Upload size={27} /><strong>{busy ? '正在处理数据库，请保持应用打开…' : '选择 SQLite 数据库备份'}</strong><span>直接读取 SQLite 二进制，不受 JSON 的 80 MiB 限制；处理容量取决于手机可用内存和存储。</span></button>
    {error && <ErrorNotice message={error} />}
    {preview && <div className="import-preview sqlite-restore-preview"><h3>已通过校验：{preview.filename}</h3><p className="muted">{size(preview.byteLength)} · 数据库版本 {preview.schemaVersion} · 本预览固定使用已检查的文件副本。</p>
      <div className="table-scroll"><table><thead><tr><th>数据</th><th>本机当前</th><th>恢复后</th></tr></thead><tbody>{Object.entries(labels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{preview.currentCounts[key] || 0}</td><td>{preview.counts[key] || 0}</td></tr>)}</tbody></table></div>
      <p>系统配置、模型地址/名称和 AI 分析历史随备份恢复。备份和本机的 AI 密钥均不会用于恢复后的模型配置，AI 将关闭，需重新填写密钥并启用。{preview.sourceHadAiKey && ' 已检测到备份含私有密钥，将从恢复副本中清除。'}</p>
      {preview.activeExamCount > 0 && <p className="notice">备份中有 {preview.activeExamCount} 场未交卷考试，恢复后将进入考试，完成交卷后可使用其他功能。</p>}
      <p className="muted">恢复前副本保留在此设备的应用私有存储中，可在下方导出；后续普通保存不会覆盖它。卸载应用会删除私有存储，请另外导出保存。</p>
      <label className="sqlite-restore-confirm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>我已核对预览，确认整体替换本机数据及配置。</span></label>
      <button className="button primary" type="button" disabled={busy || !acknowledged} onClick={() => void restore()}><FolderInput size={16} />{busy ? '正在备份并恢复…' : '保留当前副本并完整恢复'}</button>
      <details><summary>文件校验摘要</summary><code style={{ overflowWrap: 'anywhere' }}>SHA-256: {preview.sha256}</code></details>
    </div>}
    {backup && <div className="import-preview"><strong>最近的恢复前副本</strong><p className="muted">{new Date(backup.createdAt).toLocaleString('zh-CN')} · {size(backup.byteLength)} · 独立保留，后续保存不会覆盖。导出的副本会清除 AI 密钥。</p><button className="button" type="button" disabled={busy} onClick={() => void exportBackup()}><HardDriveDownload size={16} />保存或分享恢复前副本</button></div>}
  </section>;
}
