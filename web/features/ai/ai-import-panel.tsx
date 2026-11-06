import { AiImportWorkspace } from './ai-import-workspace';
import { AiDocumentWorkspace } from './ai-document-workspace';
import './ai.css';
import './ai-import-layout.css';

/** The import center owns navigation and the shared draft save guard. */
export function AiImportPanel({ mode }: { mode: 'import' | 'documents' }) {
  return mode === 'documents' ? <AiDocumentWorkspace /> : <AiImportWorkspace />;
}
