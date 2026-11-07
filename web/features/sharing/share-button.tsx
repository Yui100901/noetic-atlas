import { useEffect, useState } from 'react';
import { Download, Share2, Upload } from 'lucide-react';
import type { ShareSelection } from '../../../shared/models/sharing';
import type { ExportDocument } from '../../../shared/models/export-types';
import { send } from '../../shared/lib/api';
import { ErrorNotice, Modal, useApp } from '../../shared/ui/components';
import { downloadExport } from '../../shared/export/export-download';
import { isNativeApp } from '@platform';
import { exportPackage } from '../../shared/lib/data-package';
import { useExportPreflight } from '../../shared/export/export-preflight';
import './sharing.css';

export function ShareButton({
  kind,
  id,
  ids,
  filters,
  learning,
  label = '分享',
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: ShareSelection & {
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useApp();
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  const selection: ShareSelection = {
    kind,
    ...(id ? { id } : {}),
    ...(ids?.length ? { ids } : {}),
    ...(filters ? { filters } : {}),
    ...(learning ? { learning } : {}),
  };
  const preflight = useExportPreflight(open ? { kind: 'share', selection } : null);
  const exportFile = async (format: 'zip' | 'pdf' | 'md') => {
    if (!preflight.allowed) return;
    setBusy(true);
    setError('');
    try {
      if (format === 'zip') {
        await exportPackage({ kind: 'share', selection });
      } else {
        const document = await send<ExportDocument>(
          '/api/sharing/export-document',
          'POST',
          selection,
        );
        await downloadExport(document, format);
      }
      toast(isNativeApp() ? '文件已准备，可在系统分享面板选择QQ、微信等应用' : '分享文件已下载');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!hideTrigger && (
        <button
          className="button"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          <Share2 size={15} />
          {label}
        </button>
      )}
      {open && (
        <Modal
          title="分享内容"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p className="muted">
            ZIP数据包包含题目、领域、祖先分类、标签、独立图片与manifest清单，可直接导入另一套认知星图。PDF及Markdown含答案与解析，适合阅读。批量题集使用ZIP保留各卷结构与分值。
          </p>
          {preflight.view}
          {error && <ErrorNotice message={error} />}
          <div className="share-export-actions">
            <button
              className="button primary"
              disabled={busy || !preflight.allowed}
              onClick={() => void exportFile('zip')}
            >
              <Download size={16} />
              {busy ? '正在准备…' : '导出完整分享数据包（ZIP）'}
            </button>
            {(kind !== 'paper' || !!id) && (
              <>
                <button
                  className="button"
                  disabled={busy || !preflight.allowed}
                  onClick={() => void exportFile('pdf')}
                >
                  <Download size={16} />
                  导出分享PDF
                </button>
                <button
                  className="button"
                  disabled={busy || !preflight.allowed}
                  onClick={() => void exportFile('md')}
                >
                  <Download size={16} />
                  导出分享Markdown
                </button>
              </>
            )}
          </div>
          <div className="notice info">
            分享不包含学习笔记、练习记录、草稿、系统配置或AI密钥。题目本身如含个人项目或私密信息，请先检查再分享。Android可通过系统文件分享选择QQ或微信。
          </div>
          <a className="button feature-entry" href="#/sharing" onClick={() => setOpen(false)}>
            <Upload size={16} />
            导入朋友的分享包
          </a>
        </Modal>
      )}
    </>
  );
}
