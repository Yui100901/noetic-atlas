import { useTaskResume } from '../tasks/use-task-resume';
import { useEffect, useRef, useState } from 'react';
import { Database, Download, Eye, Upload } from 'lucide-react';
import { isNativeApp } from '@platform';
import type { SQLiteMigrationPreview } from '../../../shared/models/sqlite-migration';
import { exportSQLiteMigration } from '../../shared/lib/sqlite-migration';
import { request } from '../../shared/lib/api';
import { upgradeGuideHref } from '../../shared/lib/feature-destinations';
import { ErrorNotice, PageHeader, useApp } from '../../shared/ui/components';
import { SQLiteRestore } from './sqlite-restore';
import { sqliteRecordLabels } from './sqlite-record-labels';
import './migration.css';

export function DataPage({ embedded = false }: { embedded?: boolean }) {
  const { bootstrap, toast } = useApp();
  const [scope, setScope] = useState<'all' | 'domains'>('all');
  const [domainIds, setDomainIds] = useState<string[]>([]);
  const [format, setFormat] = useState<'zip' | 'sqlite'>('zip');
  const [preview, setPreview] = useState<SQLiteMigrationPreview | null>(null);
  const [phase, setPhase] = useState<'preview' | 'export' | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const exportObserver = useRef<AbortController>(null);
  useEffect(
    () => () => {
      generation.current++;
      exportObserver.current?.abort();
    },
    [],
  );
  useTaskResume(
    '/api/migrations/preview',
    true,
    (_input, result) => {
      const value = result.json as SQLiteMigrationPreview;
      setPreview(value);
      setScope(value.scope);
      setDomainIds(value.domainIds);
      setError('');
    },
    (reason) => setError((reason as Error).message),
  );
  const selectedIds = scope === 'all' ? [] : domainIds;
  const change = (nextScope: typeof scope, nextIds = domainIds) => {
    generation.current++;
    setScope(nextScope);
    setDomainIds(nextIds);
    setPreview(null);
    setError('');
    setPhase(null);
  };
  const inspect = async () => {
    if (phase || (scope === 'domains' && !domainIds.length)) return;
    const current = ++generation.current;
    setPhase('preview');
    setError('');
    setPreview(null);
    try {
      const value = await request<SQLiteMigrationPreview>('/api/migrations/preview', {
        method: 'POST',
        body: JSON.stringify({ domainIds: selectedIds }),
      });
      if (current === generation.current) setPreview(value);
    } catch (reason) {
      if (current === generation.current) setError((reason as Error).message);
    } finally {
      if (current === generation.current) setPhase(null);
    }
  };
  const perform = async () => {
    if (!preview || phase) return;
    const current = ++generation.current;
    const controller = new AbortController();
    exportObserver.current = controller;
    setPhase('export');
    setError('');
    try {
      await exportSQLiteMigration(preview, format, controller.signal);
      if (current === generation.current)
        toast(isNativeApp() ? '迁移文件已准备，可选择保存位置' : '迁移文件已下载');
    } catch (reason) {
      if (current === generation.current) {
        setError((reason as Error).message);
        setPreview(null);
      }
    } finally {
      if (current === generation.current) setPhase(null);
    }
  };
  return (
    <div className="settings-data ui-stack">
      {!embedded && (
        <PageHeader
          eyebrow="YOUR KNOWLEDGE, YOUR DATA"
          title="数据迁移"
          description="迁移整个学习站，或带走指定领域及其学习记录。"
        />
      )}
      <section className="card ui-stack" aria-label="SQLite 数据迁移">
        <div className="import-heading">
          <Database size={23} />
          <div>
            <h2>数据迁移</h2>
            <p>使用 SQLite 一致性副本迁移内容、配置和学习记录。导出不会修改本机数据。</p>
          </div>
        </div>
        <fieldset className="migration-options" disabled={phase === 'export'}>
          <legend>迁移范围</legend>
          <label>
            <input
              type="radio"
              name="migration-scope"
              checked={scope === 'all'}
              onChange={() => change('all')}
            />
            整个学习站
          </label>
          <label>
            <input
              type="radio"
              name="migration-scope"
              checked={scope === 'domains'}
              onChange={() => change('domains')}
            />
            指定领域
          </label>
        </fieldset>
        {scope === 'domains' && (
          <fieldset className="migration-domains" disabled={phase === 'export'}>
            <legend>选择领域（可多选）</legend>
            {bootstrap.domains.map((domain) => (
              <label key={domain.id}>
                <input
                  type="checkbox"
                  checked={domainIds.includes(domain.id)}
                  onChange={(event) =>
                    change(
                      'domains',
                      event.target.checked
                        ? [...domainIds, domain.id]
                        : domainIds.filter((id) => id !== domain.id),
                    )
                  }
                />
                {domain.name}
              </label>
            ))}
            {!bootstrap.domains.length && <p className="muted">当前没有可迁移的领域。</p>}
          </fieldset>
        )}
        <fieldset className="migration-options" disabled={phase === 'export'}>
          <legend>文件格式</legend>
          <label>
            <input
              type="radio"
              name="migration-format"
              checked={format === 'zip'}
              onChange={() => setFormat('zip')}
            />
            SQLite 迁移包（ZIP）
          </label>
          <label>
            <input
              type="radio"
              name="migration-format"
              checked={format === 'sqlite'}
              onChange={() => setFormat('sqlite')}
            />
            SQLite 数据库（.sqlite）
          </label>
        </fieldset>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={!!phase || (scope === 'domains' && !domainIds.length)}
            onClick={() => void inspect()}
          >
            <Eye size={16} />
            {phase === 'preview' ? '正在核对范围…' : '预览迁移范围'}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!!phase || !preview}
            onClick={() => void perform()}
          >
            <Download size={16} />
            {phase === 'export' ? '正在生成迁移文件…' : '导出迁移文件'}
          </button>
        </div>
        {error && <ErrorNotice message={error} />}
        {preview && (
          <div className="migration-preview ui-stack" aria-live="polite">
            <strong>
              {preview.scope === 'all' ? '整个学习站' : `${preview.domainIds.length} 个领域`} · 迁移{' '}
              {preview.counts.questions || 0} 道题目
            </strong>
            {preview.scope === 'domains' && (
              <p className="muted">
                选中领域 {preview.seedQuestions} 题，另保留 {preview.dependencyQuestions}{' '}
                道引用题。相关题集和已答卷保持完整，避免丢失答案与来源。
              </p>
            )}
            <div className="migration-counts">
              {Object.entries(preview.counts)
                .filter(([, count]) => count > 0)
                .map(([key, count]) => (
                  <div key={key}>
                    <span>{sqliteRecordLabels[key] || key}</span>
                    <strong>{count.toLocaleString()}</strong>
                  </div>
                ))}
            </div>
            {preview.warnings.length > 0 && (
              <ul className="notice">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <details className="help-disclosure">
          <summary>迁移包含什么，如何恢复？</summary>
          <p>
            保留相关题目、资料及附件、完整作答历史和答案、学习状态、笔记、复习调度、编辑草稿及 AI
            处理记录。AI 密钥会清除，恢复后需重新配置。具体范围以预览为准。
          </p>
          <p>
            迁移用于恢复数据库，会整体替换目标学习站。仅向他人分享题目、合并内容，请使用“分享与导入”。
          </p>
        </details>
      </section>
      {isNativeApp() ? (
        <SQLiteRestore />
      ) : (
        <section className="card ui-stack">
          <h2>恢复迁移数据库</h2>
          <p>
            <strong>Windows 免安装版</strong>建议先导出整个学习站的 <code>.sqlite</code>{' '}
            文件。完全退出桌面程序，另存目标目录的原 <code>data</code> 文件夹，在新建的{' '}
            <code>data</code> 文件夹中将导出文件保存为 <code>noetic-atlas.sqlite</code>
            ，再启动核对。
          </p>
          <p>
            <strong>Web 部署</strong>时先停服务并备份目标库。可直接使用原始 <code>.sqlite</code>
            ，或用 <code>npm run data:unpack -- 文件路径 输出.sqlite</code> 校验并提取 ZIP 包，再将{' '}
            <code>DATABASE_PATH</code> 指向恢复文件后启动。
          </p>
          <p className="muted">
            恢复会整体替换目标库。指定领域迁移也应恢复到独立数据库；需要合并题目时使用分享包。
          </p>
          <div>
            <a className="button" href={upgradeGuideHref}>
              备份、升级与恢复
            </a>
          </div>
        </section>
      )}
      <div>
        <a className="button" href="#/sharing?tab=export">
          <Upload size={16} />
          只分享题目
        </a>
      </div>
    </div>
  );
}
