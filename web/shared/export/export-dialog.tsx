import { useState } from 'react';
import { Download, FileText, LoaderCircle } from 'lucide-react';
import { exportModeLabels, type ExportDocument, type ExportMode } from '../../../shared/models/export-types';
import { idPath, request } from '../lib/api';
import { ErrorNotice, Modal, useApp } from '../ui/components';
import { downloadExport } from './export-download';
import { isNativeApp } from '@platform';
import './export.css';

const descriptions: Record<ExportMode, string> = { blank: '仅含题干、选项和答题区，不含参考答案与解析。', answers: '完整题目、参考答案与解析，适合打印复习。', completed: '本次提交的作答、参考答案、正误与判分；未评主观题标为待阅。' };
export function ExportButton({ paperId, attemptId }: { paperId?: string; attemptId?: string }) {
  const [open, setOpen] = useState(false);
  return <><button className="button" onClick={() => setOpen(true)}><Download size={16} />导出题集</button>{open && <ExportDialog paperId={paperId} attemptId={attemptId} onClose={() => setOpen(false)} />}</>;
}
function ExportDialog({ paperId, attemptId, onClose }: { paperId?: string; attemptId?: string; onClose: () => void }) {
  const [mode, setMode] = useState<ExportMode>(attemptId ? 'completed' : 'blank'); const [format, setFormat] = useState<'md' | 'pdf'>('pdf');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const { toast } = useApp();
  const modes: ExportMode[] = attemptId ? ['completed', 'blank', 'answers'] : ['blank', 'answers'];
  const run = async () => {
    setBusy(true); setError('');
    try {
      const path = attemptId ? `/api/attempts/${idPath(attemptId)}/export-document` : `/api/papers/${idPath(paperId!)}/export-document`;
      const document = await request<ExportDocument>(`${path}?mode=${mode}`);
      await downloadExport(document, format); toast(isNativeApp() ? '导出文件已准备，请在系统分享中保存。' : '文件已生成并开始下载。');
    } catch (err) { setError((err as Error).message || '文件导出失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <Modal title="导出题集" onClose={() => { if (!busy) onClose(); }}><div className="export-dialog">
    <p className="export-intro">{attemptId ? '以下三种模式均使用本次练习的历史快照，保留当时的题目与分值。' : '使用当前题集保存的题目快照。完成卷请从已交卷的练习记录中导出。'}</p>
    <fieldset disabled={busy} className="export-options"><legend>内容模式</legend>{modes.map(value => <label key={value} className={`export-option ${mode === value ? 'selected' : ''}`}><input type="radio" name="export-mode" value={value} checked={mode === value} onChange={() => setMode(value)} /><span><strong>{exportModeLabels[value]}</strong><small>{descriptions[value]}</small></span></label>)}</fieldset>
    <fieldset disabled={busy} className="export-format"><legend>文件格式</legend>{(['pdf', 'md'] as const).map(value => <label key={value} className={format === value ? 'selected' : ''}><input type="radio" name="export-format" value={value} checked={format === value} onChange={() => setFormat(value)} /><FileText size={17} /><span>{value === 'pdf' ? 'PDF 文档' : 'Markdown (.md)'}</span></label>)}</fieldset>
    <p className="export-note">{format === 'pdf' ? 'PDF 使用内置中文字体，在本机生成并自动分页。首次生成可能需要稍候。' : 'Markdown 为可编辑文本，便于迁移、修改或导入其他笔记工具。'}</p>
    {error && <ErrorNotice message={error} />}
    <div className="export-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{busy ? '正在生成文件…' : isNativeApp() ? '生成并保存 / 分享' : '下载文件'}</button></div>
  </div></Modal>;
}
