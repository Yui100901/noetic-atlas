import { useTaskDetachable } from '../../features/tasks/use-task-detachable';
import { useRef, useState } from 'react';
import { Download, FileText, LoaderCircle, Share2 } from 'lucide-react';
import {
  exportModeLabels,
  type ExportDocument,
  type ExportMode,
} from '../../../shared/models/export-types';
import { idPath, request } from '../lib/api';
import { ErrorNotice, Modal, useApp } from '../ui/components';
import { downloadExport } from './export-download';
import { isNativeApp } from '@platform';
import './export.css';
import { exportPackage } from '../lib/data-package';
import { useExportPreflight } from './export-preflight';

const descriptions: Record<ExportMode, string> = {
  blank: '仅含题干、选项和答题区，不含参考答案与解析。',
  answers: '完整题目、参考答案与解析，适合打印复习。',
  completed: '本次提交的作答、参考答案、正误与判分；未评主观题标为待阅。',
};
export function ExportButton({
  paperId,
  attemptId,
  share = false,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  paperId?: string;
  attemptId?: string;
  share?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };
  return (
    <>
      {!hideTrigger && (
        <button className="button" onClick={() => setOpen(true)}>
          {share ? <Share2 size={16} /> : <Download size={16} />}
          {share ? '分享' : '导出题集'}
        </button>
      )}
      {open && (
        <ExportDialog
          paperId={paperId}
          attemptId={attemptId}
          share={share}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function ExportDialog({
  paperId,
  attemptId,
  share = false,
  onClose,
}: {
  paperId?: string;
  attemptId?: string;
  share?: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ExportMode>(
    attemptId ? 'completed' : share ? 'answers' : 'blank',
  );
  const [format, setFormat] = useState<'md' | 'pdf' | 'zip'>('pdf');
  const preflight = useExportPreflight(
    format === 'zip' && paperId && !attemptId
      ? { kind: 'share', selection: { kind: 'paper', id: paperId } }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detachable = useTaskDetachable('/api/packages/export', busy && format === 'zip');
  const active = useRef<AbortController>(null);
  const close = () => {
    if (!busy || format !== 'zip' || detachable) {
      if (detachable) active.current?.abort();
      onClose();
    }
  };
  const { toast } = useApp();
  const modes: ExportMode[] = attemptId ? ['completed', 'blank', 'answers'] : ['blank', 'answers'];
  const run = async () => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      if (format === 'zip') {
        if (!paperId || !preflight.allowed) return;
        await exportPackage(
          { kind: 'share', selection: { kind: 'paper', id: paperId } },
          controller.signal,
        );
        toast('题集数据包已准备，可在另一套认知星图导入。');
        return;
      }
      const path = attemptId
        ? `/api/attempts/${idPath(attemptId)}/export-document`
        : `/api/papers/${idPath(paperId!)}/export-document`;
      const document = await request<ExportDocument>(`${path}?mode=${mode}`, {
        signal: controller.signal,
      });
      await downloadExport(document, format, controller.signal);
      toast(isNativeApp() ? '导出文件已准备，请在系统分享中保存。' : '文件已生成并开始下载。');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const message = (err as Error).message || '文件导出失败，请重试。';
        setError(message);
        toast(message, true);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={share ? '分享题集' : '导出题集'} onClose={close}>
      <div className="export-dialog">
        <p className="export-intro">
          {attemptId
            ? '以下三种模式均使用本次练习的历史快照，保留当时的题目与分值。'
            : '使用当前题集保存的题目快照。完成卷请从已交卷的练习记录中导出。'}
        </p>
        <fieldset disabled={busy} className="export-format">
          <legend>文件格式</legend>
          {(attemptId ? (['pdf', 'md'] as const) : (['pdf', 'md', 'zip'] as const)).map((value) => (
            <label key={value} className={format === value ? 'selected' : ''}>
              <input
                type="radio"
                name="export-format"
                value={value}
                checked={format === value}
                onChange={() => setFormat(value)}
              />
              <FileText size={17} />
              <span>
                {value === 'pdf'
                  ? 'PDF 文档'
                  : value === 'zip'
                    ? '题集数据包（ZIP）'
                    : 'Markdown (.md)'}
              </span>
            </label>
          ))}
        </fieldset>
        {format !== 'zip' && (
          <fieldset disabled={busy} className="export-options">
            <legend>内容模式</legend>
            {modes.map((value) => (
              <label key={value} className={`export-option ${mode === value ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="export-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>
                  <strong>{exportModeLabels[value]}</strong>
                  <small>{descriptions[value]}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="export-note">
          {format === 'zip'
            ? 'ZIP包含题集、完整题目与答案、计分和判题要求、分类标签及图片，通过manifest组织，可再次导入。不含个人作答、笔记和配置；空白卷或完成卷请用PDF或Markdown。'
            : format === 'pdf'
              ? 'PDF 使用内置中文字体，在本机生成并自动分页。首次生成可能需要稍候。'
              : 'Markdown 为可编辑文本，便于迁移、修改或导入其他笔记工具。'}
        </p>
        {preflight.view}
        {detachable && (
          <p className="notice info">
            数据包正在后台生成，可关闭此窗口或切换页面；完成后从顶部任务通知下载。
          </p>
        )}
        {error && <ErrorNotice message={error} />}
        <div className="export-actions">
          <button
            className="button"
            disabled={busy && format === 'zip' && !detachable}
            onClick={close}
          >
            {busy ? '关闭并继续生成' : '取消'}
          </button>
          {busy && format !== 'zip' && (
            <button type="button" className="button" onClick={() => active.current?.abort()}>
              取消生成
            </button>
          )}
          <button
            className="button primary"
            disabled={busy || (format === 'zip' && !preflight.allowed)}
            onClick={() => void run()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
            {busy ? '正在生成文件…' : isNativeApp() ? '生成并保存 / 分享' : '下载文件'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
