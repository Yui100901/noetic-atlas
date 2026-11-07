import { lazy, Suspense } from 'react';
import { PageHeader, Loading } from '../../shared/ui/components';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import './sharing.css';
import { AiWorkspaceDraftSession, useAiDraftSession } from '../ai/ai-workspace-draft-context';
const AiImportPanel = lazy(() =>
  import('../ai/ai-import-panel').then((module) => ({ default: module.AiImportPanel })),
);
const QuestionImportPage = lazy(() =>
  import('../questions/question-import').then((module) => ({ default: module.QuestionImportPage })),
);

const DomainExport = lazy(() =>
  import('../settings/domain-export').then((module) => ({ default: module.DomainExport })),
);
const PaperSharing = lazy(() =>
  import('./paper-sharing').then((module) => ({ default: module.PaperSharing })),
);
const importTabs = [
  { id: 'package', label: '数据包导入' },
  { id: 'export', label: '按领域分享' },
  { id: 'papers', label: '题集分享' },
  { id: 'template', label: '模板与批量新增' },
  { id: 'import', label: 'AI整理题目' },
] as const;

export { ShareButton } from './share-button';

export function SharingPage({ initialTab = 'package' }: { initialTab?: string }) {
  return (
    <AiWorkspaceDraftSession>
      <SharingContent initialTab={initialTab} />
    </AiWorkspaceDraftSession>
  );
}
function SharingContent({ initialTab }: { initialTab: string }) {
  const session = useAiDraftSession()!;
  const tab =
    initialTab === 'documents'
      ? 'import'
      : importTabs.some((item) => item.id === initialTab)
        ? initialTab
        : 'package';
  const select = (next: string) =>
    void session.transition(() => {
      window.location.hash = '#/sharing' + (next === 'package' ? '' : '?tab=' + next);
    });
  return (
    <div className={tab === 'import' ? 'ai-workspace-import' : undefined}>
      <PageHeader
        eyebrow="SHARE & IMPORT"
        title="接收内容，整理成自己的知识。"
        description="数据包直接导入；原始文件可用 AI 整理并按需分批出题，核对后再入库。"
        actions={
          <a className="button" href="#/questions/review">
            查看待审核题目
          </a>
        }
      />
      <nav className="section-tabs sharing-import-tabs" aria-label="内容导入方式">
        {importTabs.map((item) => (
          <button
            type="button"
            key={item.id}
            className={tab === item.id ? 'selected' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => select(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {tab === 'package' ? (
        <div className="ui-stack">
          <DataPackageImport purpose="content" title="导入内容数据包" />
          <details className="card help-disclosure">
            <summary>选择哪种导入方式？</summary>
            <p>
              已有认知星图 ZIP：在此整包校验、查重并确认。未经整理的题目文件或教材：切到 AI
              整理题目。自己编写的批量题目：使用模板与批量新增。
            </p>
            <p>
              新增内容仍需审核；可信备份合并保留原状态。SQLite整体或领域迁移与完整恢复位于系统配置。内容分享不包含学习记录。
            </p>
            <a className="button" href="#/settings?tab=backup">
              SQLite 迁移与恢复
            </a>
          </details>
        </div>
      ) : (
        <Suspense fallback={<Loading text="正在加载内容整理工具…" />}>
          {tab === 'export' ? (
            <DomainExport />
          ) : tab === 'papers' ? (
            <PaperSharing />
          ) : tab === 'template' ? (
            <QuestionImportPage embedded />
          ) : (
            <AiImportPanel key={tab} mode={initialTab === 'documents' ? 'documents' : 'import'} />
          )}
        </Suspense>
      )}
    </div>
  );
}
