import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Check,
  Database,
  Download,
  FileJson,
  FolderInput,
  HardDriveDownload,
  Upload,
} from 'lucide-react';
import { download, send } from '../../shared/lib/api';
import { ErrorNotice, PageHeader, useApp } from '../../shared/ui/components';
import { isNativeApp } from '@platform';
import { ConfigurationTransfer } from './configuration-transfer';
import { DomainExport } from './domain-export';
import { SQLiteRestore } from './sqlite-restore';

export type DataPageMode = 'content' | 'backup' | 'configuration' | 'all';
type MigrationFile = Record<string, unknown> & { questions: unknown[]; domains: unknown[] };

/** Ignore superseded File.text reads before parsing or publishing the selected package. */
function BackupMerge() {
  const { toast, reload } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [data, setData] = useState<MigrationFile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const fileReadVersion = useRef(0);
  useEffect(
    () => () => {
      ++fileReadVersion.current;
    },
    [],
  );
  const loadFile = async (file?: File) => {
    if (!file || busy) return;
    const version = ++fileReadVersion.current;
    const current = () => fileReadVersion.current === version;
    setReading(true);
    setError('');
    setResult(null);
    setData(null);
    setFileName(file.name);
    try {
      if (file.size > 80 * 1024 * 1024)
        throw new Error(
          'JSON 文件超过 80 MiB；请使用 SQLite 完整恢复，或按领域拆分导出后逐份导入。',
        );
      const text = await file.text();
      if (!current()) return;
      const parsed = JSON.parse(text);
      if (parsed?.format === 'learning-share')
        throw new Error(
          '这是分享包，请使用“导入分享包”。分享新增题目必须先审核，不能按可信备份迁移。',
        );
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.format !== undefined ||
        !Array.isArray(parsed.questions) ||
        !Array.isArray(parsed.domains)
      )
        throw new Error(
          '文件不是受支持的迁移 JSON：至少应包含 questions 和 domains。新增题目和分享包请使用各自的导入入口。',
        );
      setData(parsed as MigrationFile);
    } catch (err) {
      if (current()) setError((err as Error).message);
    } finally {
      if (current()) setReading(false);
    }
  };
  const importData = async () => {
    if (!data || busy || reading) return;
    setBusy(true);
    setError('');
    try {
      const imported = await send('/api/import', 'POST', { data, mode: 'merge' });
      setResult(imported);
      setData(null);
      toast('数据导入完成，已有内容按迁移规则保留');
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const count = (key: string) => (Array.isArray(data?.[key]) ? data[key].length : 0);
  return (
    <section className="card import-card" aria-label="可信备份合并导入">
      <div className="import-heading">
        <FolderInput size={23} />
        <div>
          <h2>从备份合并导入</h2>
          <p>
            用于自己的领域迁移包或可信完整备份，保留原发布与审核状态；校验失败回滚。ZIP
            请先解压，再逐份导入其中的 JSON。新增题目和分享包使用下方独立入口。
          </p>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="选择 JSON 备份文件"
        disabled={busy}
        onChange={(event) => void loadFile(event.target.files?.[0])}
      />
      <button
        className="import-dropzone"
        type="button"
        onClick={() => {
          if (fileRef.current) fileRef.current.value = '';
          fileRef.current?.click();
        }}
        disabled={busy}
      >
        <Upload size={27} />
        <strong>{fileName || '选择 JSON 备份文件'}</strong>
        <span>单份 JSON 最多 80 MiB；较大备份请选择 SQLite 完整恢复。</span>
      </button>
      {reading && <p role="status">正在读取备份文件…可重新选择其他文件。</p>}
      {error && <ErrorNotice message={error} />}
      {data && (
        <div className="import-preview">
          <strong>准备导入：{fileName}</strong>
          <div className="import-counts">
            <span>{data.questions.length} 道题目</span>
            <span>{count('documents')} 份资料</span>
            <span>{data.domains.length} 个领域</span>
            <span>{count('tags')} 个标签</span>
            <span>{count('papers')} 份题集</span>
            <span>{count('questionDrafts')} 份题目编辑草稿</span>
            <span>{count('questionRevisions')} 条题目修订</span>
          </div>
          <p className="muted">
            同 ID 已有内容会跳过。系统配置仅在本机仍使用初始默认值时恢复，已有自定义配置会保留。
          </p>
          <button
            className="button primary"
            disabled={busy || reading}
            onClick={() => void importData()}
          >
            <FolderInput size={16} />
            {busy ? '正在校验并导入…' : '确认合并导入'}
          </button>
        </div>
      )}
      {result !== null && (
        <div className="notice success">
          <Check size={17} />
          <div>
            <strong>导入完成</strong>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </div>
        </div>
      )}
      <div className="form-actions">
        <a className="button" href="#/sharing">
          导入分享包
        </a>
        <a className="button" href="#/questions/import">
          批量新增题目 / 下载模板
        </a>
        <a className="button" href="#/questions/review">
          修改与审核已有待审核题
        </a>
      </div>
    </section>
  );
}

export function DataPage({
  embedded = false,
  mode = 'all',
}: {
  embedded?: boolean;
  mode?: DataPageMode;
}) {
  const native = isNativeApp();
  const content = mode === 'content' || mode === 'all';
  const backup = mode === 'backup' || mode === 'all';
  return (
    <div className="settings-data ui-stack">
      {!embedded && (
        <PageHeader
          eyebrow="YOUR KNOWLEDGE, YOUR DATA"
          title="把积累，留在自己手中。"
          description="按领域迁移内容、完整备份和配置迁移分别管理。"
        />
      )}
      {(mode === 'configuration' || mode === 'all') && <ConfigurationTransfer />}
      {content && <DomainExport />}
      {backup && (
        <div className="data-grid">
          <section className="card data-card">
            <div className="data-icon">
              <FileJson size={25} />
            </div>
            <h2>完整 JSON 备份</h2>
            <p>
              包含题目、题集、资料、图片/PDF、题目编辑草稿与修订历史、常规配置、分类标签及学习记录。AI私有配置和分析历史不在JSON中，已追加到笔记的内容保留。
            </p>
            <button
              className="button primary"
              onClick={() => download('/api/export', '认知星图-完整备份.json')}
            >
              <Download size={16} />
              导出全部数据
            </button>
            <span className="data-detail">结构化备份 · schemaVersion 1</span>
          </section>
          <section className="card data-card">
            <div className="data-icon warm">
              <Database size={25} />
            </div>
            <h2>SQLite 数据库备份</h2>
            <p>
              {native
                ? '分享一致性副本，保留内容及AI分析历史，导出时清除AI密钥。可在手机或电脑完整恢复，AI密钥需重填。'
                : '下载一致性副本，保留内容和AI分析历史，导出时清除AI密钥。可在另一台电脑恢复，模型密钥需重新填写。'}
            </p>
            <button
              className="button"
              onClick={() => download('/api/backup.sqlite', '认知星图-学习数据库.sqlite')}
            >
              <HardDriveDownload size={16} />
              {native ? '保存或分享 SQLite' : '下载 SQLite'}
            </button>
            <span className="data-detail">单文件数据库 · 便于长期保存</span>
          </section>
        </div>
      )}
      {(content || backup) && <BackupMerge />}
      {backup && native && <SQLiteRestore />}
      {backup && (
        <div className="quiet-note">
          <Archive size={20} />
          <div>
            <h3>一份备份，两种迁移方式。</h3>
            <p>
              {native
                ? 'JSON 用于合并内容，同 ID 保留当前版本。SQLite 用于整体替换，包含学习记录、资料和 AI 分析历史；恢复前会保留本机独立副本。将备份导出到应用以外的位置，便于换设备后继续学习。'
                : 'JSON 用于合并内容。SQLite 用于完整恢复：停止服务后，将下载的数据库放到目标位置，通过 DATABASE_PATH 指向它，再启动服务。定期把备份保存在自己的其他磁盘。'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
