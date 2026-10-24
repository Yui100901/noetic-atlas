import { useEffect, useState, type FormEvent } from 'react';
import { Download, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { AssetMetadata } from '../../../shared/assets/assets';
import { DEFAULT_SETTINGS, type RetentionPreview, type SystemSettings } from '../../../shared/models/settings';
import { typeLabels, type QuestionType } from '../../../shared/models/types';
import { ApiError, idPath, localDate, send, useResource } from '../../shared/lib/api';
import { DataPage } from './data';
import { ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, SearchBox, useApp } from '../../shared/ui/components';
import { decodeAsset, fetchAsset } from '../../shared/media/asset-files';
import { saveGeneratedFile } from '@platform';
import '../../shared/media/media.css';
import { AiSettingsForm } from '../ai/ai-settings';
import {usePagination} from '../../shared/lib/pagination';

type Tab = 'practice' | 'assets' | 'backup' | 'ai';
export function SettingsPage({ initialTab = 'practice' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return <><PageHeader eyebrow="SYSTEM SETTINGS" title="让学习空间，适合自己的节奏。" description="调整练习默认值、记录保留和文件限制；已有题集与作答继续使用各自快照。" /><nav className="settings-tabs" aria-label="系统配置分区">{([['practice','学习与练习'],['assets','文件资源'],['backup','数据与备份'],['ai','AI辅助']] as const).map(([value,label]) => <button className={`button ${tab === value ? 'selected' : ''}`} key={value} onClick={() => setTab(value)} aria-current={tab === value ? 'page' : undefined}>{label}</button>)}</nav>{tab === 'practice' ? <SettingsForm /> : tab === 'assets' ? <AssetsManager /> : tab === 'ai' ? <AiSettingsForm /> : <DataPage embedded />}</>;
}
function SettingsForm() {
  const resource = useResource<SystemSettings>('/api/settings'); const { reload, toast } = useApp();
  const [form, setForm] = useState<SystemSettings>(structuredClone(DEFAULT_SETTINGS)); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retention, setRetention] = useState<RetentionPreview | null>(null);
  useEffect(() => { if (resource.data) setForm(resource.data); }, [resource.data]);
  const set = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => setForm(old => ({ ...old, [key]: value }));
  const save = async (confirmed = false) => {
    setBusy(true); setError('');
    try {
      const result = await send<{settings:SystemSettings;retention:RetentionPreview}>('/api/settings', 'PUT', { settings: form, ...(confirmed ? { confirmedRetention: true, expectedRetention: retention } : {}) });
      resource.setData(result.settings); setRetention(null); reload(); toast(result.retention.total ? `配置已保存，清理 ${result.retention.total} 份超限记录` : '系统配置已保存');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RETENTION_CONFIRMATION_REQUIRED') setRetention(err.details as RetentionPreview);
      else { setRetention(null); setError((err as Error).message); }
    } finally { setBusy(false); }
  };
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice message={resource.error} retry={resource.refresh} />;
  const number = (key: keyof SystemSettings, label: string, min: number, max: number, hint?: string, step = 1) => <Field label={label} hint={hint}><input required type="number" inputMode="decimal" min={min} max={max} step={step} value={form[key] as number} onChange={e => set(key, Number(e.target.value) as never)} /></Field>;
  const submit = (event: FormEvent) => { event.preventDefault(); void save(); };
  return <><form id="system-settings-form" onSubmit={submit}><div className="settings-footer"><span className="muted">最近保存 {localDate(form.updatedAt)}</span><div className="action-row"><button type="button" className="button" disabled={busy} onClick={() => { setForm({ ...structuredClone(DEFAULT_SETTINGS), updatedAt: resource.data!.updatedAt }); setRetention(null); }}><RotateCcw size={15} />填入初始默认值</button><button className="button primary" disabled={busy} type="submit"><Save size={15} />{busy ? '正在保存…' : '保存系统配置'}</button></div></div>{error && <ErrorNotice message={error} retry={resource.refresh} />}
    <section className="card settings-section"><h2>草稿与练习历史</h2><div className="form-grid">{number('maxDraftsPerPaper','每题集最多草稿数',1,100,'默认3；继续覆盖原草稿，新开超限时清理最旧未提交记录。')}{number('maxPaperDrafts','每个组题上下文最多草稿数',1,100,'默认3；新建组题与每个已有题集的编辑草稿分别保留，继续编辑覆盖同一草稿。')}{number('maxQuickDrafts','随机自测最多草稿数',1,100,'随机自测独立管理，默认3。')}{number('maxHistoryPerPaper','每题集最多已提交历史',0,10000,'0表示不限量，保持原默认。非0时仅保留最近提交的记录。')}{number('maxQuickHistory','随机自测最多已提交历史',0,10000,'0表示不限量。与具体题集分别计算。')}</div><p className="muted">调低上限若会删除现有记录，会先显示具体数量再确认。题目、题集、笔记与掌握记录保留，可先到数据与备份导出完整副本。</p></section>
    <section className="card settings-section"><h2>新建与随机组题默认值</h2><div className="check-row"><label><input type="checkbox" checked={form.scoringEnabledByDefault} onChange={e => set('scoringEnabledByDefault', e.target.checked)} />新建题集默认启用计分</label></div><div className="form-grid">{number('examDurationMinutes','考试模式默认时长（分钟）',1,1440,'默认120分钟。每次开始考试前可单独调整。')}{number('randomQuestionCount','随机无分练习默认题量',1,500)}{number('randomTotalPoints','随机计分默认总分',0.01,10000,undefined,0.01)}{number('objectivePercent','客观题默认目标占比（%）',0,100,`主观目标 ${100 - form.objectivePercent}%，当前默认60%/40%。`,0.01)}</div><h3>每题型默认分值</h3><div className="form-grid">{Object.entries(typeLabels).map(([type,label]) => <Field key={type} label={`${label}默认分值`} hint={type === 'group' ? '整组分值按各小题权重分配。' : undefined}><input required type="number" min="0.01" max="1000" step="0.01" value={form.pointsByType[type as QuestionType]} onChange={e => set('pointsByType', { ...form.pointsByType, [type]: Number(e.target.value) })} /></Field>)}</div><p className="muted">这些值用于新建与重置默认配置。已保存的卷面分值、已开始草稿及历史成绩不会改变。</p></section>
    <section className="card settings-section"><h2>自动保存与复习间隔</h2><div className="form-grid">{number('autosaveDebounceMs','作答自动保存等待（毫秒）',100,10000,'输入停止后等待此时长保存；离开页面仍尝试保存。')}{form.reviewIntervalsDays.map((days,index) => <Field key={index} label={`掌握${index} · ${['不会','需提示','能独立','能深入'][index]}的复习间隔（天）`}><input required type="number" min="0" max="3650" value={days} onChange={e => set('reviewIntervalsDays', form.reviewIntervalsDays.map((day,i) => i === index ? Number(e.target.value) : day) as SystemSettings['reviewIntervalsDays'])} /></Field>)}</div><p className="muted">0天表示当天复习。仅影响之后新记录的复习安排，已有日期可按题单独调整。</p></section>
    <section className="card settings-section"><h2>文件上传</h2><div className="form-grid">{number('maxDocumentMiB','单份MD / PDF上限（MiB）',1,50,'默认20 MiB。')}{number('maxImageMiB','单张图片上限（MiB）',1,20,'默认5 MiB，支持PNG、JPEG、WebP和GIF。')}</div><p className="muted">新限制只影响后续上传；已有文件与历史插图继续保留。所有本地文件和配置随完整备份迁移。</p></section>
    </form>{retention && <Modal title="确认记录保留范围" onClose={() => !busy && setRetention(null)}><p>保存此配置将移除 <strong>{retention.drafts}份草稿</strong> 与 <strong>{retention.history}份已提交历史</strong>，{retention.authoring?<>与 <strong>{retention.authoring}份组题草稿</strong>，</>:null}共{retention.total}份超限记录。</p><p>仅保留各自范围内最近记录。该操作不能从当前库撤销；题目、题集与独立学习笔记继续保留。可先取消并导出备份。</p><div className="form-actions"><button className="button" disabled={busy} onClick={() => setRetention(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => void save(true)}>确认保存并清理记录</button></div></Modal>}</>;
}
function AssetsManager() {
  const resource = useResource<Array<AssetMetadata & { referenced: boolean }>>('/api/assets'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const { toast } = useApp();
  const [search,setSearch]=useState(''); const paging=usePagination((resource.data||[]).filter(asset=>`${asset.filename} ${asset.mimeType}`.toLowerCase().includes(search.toLowerCase())),search);
  const download = async (asset: AssetMetadata) => { setBusy(true); setError(''); try { const data = await fetchAsset(asset.id); await saveGeneratedFile(data.filename, decodeAsset(data), data.mimeType); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const remove = async (asset: AssetMetadata) => { if (!confirm(`永久删除未引用文件「${asset.filename}」？`)) return; setBusy(true); setError(''); try { await send(`/api/assets/${idPath(asset.id)}`, 'DELETE'); toast('未引用文件已删除'); resource.refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <section className="card"><h2>本地文件资源</h2><p className="muted">上传图片与PDF保存在SQLite中。题目、资料及历史快照仍引用的文件受到删除保护；未引用上传可在此清理。</p><SearchBox value={search} onChange={setSearch} placeholder="搜索文件名称或格式"/>{error && <ErrorNotice message={error} />}{resource.loading ? <Loading /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : paging.total ? <><div className="table-scroll"><table><thead><tr><th>文件</th><th>大小 / 状态</th><th>操作</th></tr></thead><tbody>{paging.items.map(asset => <tr key={asset.id}><td><strong>{asset.filename}</strong><br /><small>{asset.mimeType}</small></td><td>{(asset.sizeBytes / 1024 / 1024).toFixed(2)} MiB<br />{asset.referenced ? '已引用，保留' : '未引用'}</td><td><div className="action-row"><button className="button" disabled={busy} onClick={() => void download(asset)}><Download size={14} />保存文件</button><button className="button danger-text" disabled={busy || asset.referenced} onClick={() => void remove(asset)}><Trash2 size={14} />删除</button></div></td></tr>)}</tbody></table></div><Pagination {...paging} label="文件资源"/></> : <p>暂无上传文件。可从资料库上传PDF，或在题目与资料编辑中插入图片。</p>}</section>;
}
