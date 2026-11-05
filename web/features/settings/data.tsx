import { useState } from 'react';
import { Database, Download, FileJson } from 'lucide-react';
import { ErrorNotice, PageHeader } from '../../shared/ui/components';
import { isNativeApp } from '@platform';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import { exportPackage, exportSQLitePackage } from '../../shared/lib/data-package';
import { ConfigurationTransfer } from './configuration-transfer';
import { DomainExport } from './domain-export';
import { SQLiteRestore } from './sqlite-restore';

export type DataPageMode = 'content' | 'backup' | 'configuration' | 'all';
function BackupMerge() {
  return (
    <DataPackageImport
      title="从数据包合并导入"
      description="选择领域迁移、完整备份或分享 ZIP，系统会识别用途并展示导入预览。"
    />
  );
}

function BackupExportButton({ sqlite = false }: { sqlite?: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const perform = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (sqlite) await exportSQLitePackage();
      else await exportPackage({ kind: 'migration' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className={`button ${sqlite ? '' : 'primary'}`}
        disabled={busy}
        onClick={() => void perform()}
      >
        <Download size={16} />
        {busy ? '正在准备数据包…' : sqlite ? '导出完整数据库包（ZIP）' : '导出全部数据包（ZIP）'}
      </button>
      {error && <ErrorNotice message={error} />}
    </>
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
            <h2>完整数据迁移包</h2>
            <p>合并题库、题集、资料和学习记录，同ID已有内容保留本机版本。</p>
            <details className="help-disclosure">
              <summary>迁移包包含哪些内容</summary>
              <p className="muted">
                包含分类标签、图片/PDF、编辑草稿与修订、常规配置及已保存的笔记。AI私有配置和分析历史使用完整数据库包迁移。
              </p>
            </details>
            <BackupExportButton />
            <span className="data-detail">ZIP数据包 · manifest统一描述内容</span>
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
            <BackupExportButton sqlite />
            <span className="data-detail">ZIP内含SQLite数据库及校验清单</span>
          </section>
        </div>
      )}
      {(content || backup) && <BackupMerge />}
      {backup && native && <SQLiteRestore />}
      {backup && (
        <details className="help-disclosure">
          <summary>完整恢复与备份保存说明</summary>
          <p className="muted">
            {native
              ? '数据迁移包用于合并内容，同ID保留当前版本。SQLite数据库包用于整体替换，恢复前会保留本机独立副本。将备份保存到应用以外的位置，便于换设备后继续学习。'
              : 'SQLite数据库包用于完整恢复。使用 npm run data:unpack 校验数据包并提取到新的SQLite文件，停止服务后通过 DATABASE_PATH 指向新文件，再启动服务。请将备份保存在其他磁盘。'}
          </p>
        </details>
      )}
    </div>
  );
}
