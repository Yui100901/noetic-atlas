import { AiImportWorkspace } from './ai-import-workspace';
import { AiDocumentWorkspace } from './ai-document-workspace';
import { useState } from 'react';
import { useAiDraftSession } from './ai-workspace-draft-context';
import './ai.css';
import './ai-import-layout.css';

/** The import center owns navigation and the shared draft save guard. */
export function AiImportPanel({ mode }: { mode: 'import' | 'documents' }) {
  const session = useAiDraftSession();
  const [processing, setProcessing] = useState<'import' | 'documents'>(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    return mode === 'documents' ||
      params.get('process') === 'batch' ||
      params.has('job') ||
      params.has('document')
      ? 'documents'
      : 'import';
  });
  const change = (next: typeof processing) => {
    if (next === processing) return;
    const perform = () => {
      setProcessing(next);
      const [path, query] = window.location.hash.split('?');
      const params = new URLSearchParams(query || '');
      params.set('tab', 'import');
      if (next === 'documents') params.set('process', 'batch');
      else {
        params.delete('process');
        params.delete('job');
        params.delete('document');
      }
      history.replaceState(history.state, '', path + '?' + params);
    };
    if (session) void session.transition(perform);
    else perform();
  };
  return (
    <div className="ai-import-unified ui-stack">
      <section className="card ai-import-mode-switch" aria-label="AI整理处理方式">
        <h2>处理方式</h2>
        <div className="segmented" role="group" aria-label="材料处理规模">
          <button
            type="button"
            aria-pressed={processing === 'import'}
            className={processing === 'import' ? 'selected' : ''}
            onClick={() => change('import')}
          >
            单次整理
          </button>
          <button
            type="button"
            aria-pressed={processing === 'documents'}
            className={processing === 'documents' ? 'selected' : ''}
            onClick={() => change('documents')}
          >
            教材分批出题
          </button>
        </div>
        <details className="ai-import-mode-help">
          <summary>材料规模与草稿说明</summary>
          <p className="muted">
            {processing === 'documents'
              ? '可读取多文件或整本教材，分块总结后按需出题，保存进度并重试失败批次。'
              : '单次整理适合短材料；超过模型预算时可切换教材分批处理。'}
            两种方式分别保留草稿，生成结果核对后再导入。
          </p>
        </details>
      </section>
      {processing === 'documents' ? <AiDocumentWorkspace /> : <AiImportWorkspace />}
    </div>
  );
}
