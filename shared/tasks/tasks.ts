/** Tasks hold device-local work, independently of an editor's lifetime. */
export type TaskStatus =
  'queued' | 'running' | 'committing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskInput {
  operation: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Only checkpointed textbook processing supports multiple independent steps. */
  steps?: unknown[];
  title?: string;
  returnTo?: string;
}
export interface BackgroundTask {
  id: string;
  title: string;
  operation: string;
  method: 'GET' | 'POST';
  returnTo: string;
  status: TaskStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  completedSteps: number;
  attempt: number;
  cancellable: boolean;
  createdAt: string;
  updatedAt: string;
  read: boolean;
  error?: { code: string; message: string; status?: number };
  /** Temporary model output is available only while reading an individual task. */
  previewText?: string;
}
export interface TaskResult {
  status: number;
  contentType: string;
  json?: unknown;
  binaryBase64?: string;
  binaryByteLength?: number;
  filename?: string;
}
export type TaskProgress =
  { stage: string; message: string; current?: number; total?: number } | { delta: string };
export const terminalTask = (task: BackgroundTask) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status);
export function taskOperationAllowed(operation: string, method = 'POST'): boolean {
  if (!operation.startsWith('/api/') || operation.includes('://') || operation.includes('#'))
    return false;
  const path = operation.split('?')[0]!;
  if (method === 'GET')
    return (
      ['/api/migrations/database', '/api/backup.sqlite'].includes(path) ||
      (path === '/api/maintenance/health' &&
        new URLSearchParams(operation.split('?')[1]).get('integrity') === 'true')
    );
  if (method !== 'POST') return false;
  return (
    [
      '/api/packages/preview',
      '/api/packages/import',
      '/api/packages/export',
      '/api/content-exports',
      '/api/migrations/preview',
      '/api/ai/similar-questions',
      '/api/question-feedback/ai-review',
      '/api/ai/paper-plan',
      '/api/ai/import',
      '/api/ai/explain',
      '/api/ai/grade',
      '/api/ai/review',
      '/api/ai/question-edit',
    ].includes(path) ||
    /^\/api\/ai\/document-jobs\/[\w.:-]+\/(plan|generate|import-preview|import)$/.test(path) ||
    /^\/api\/ai\/runs\/[\w.:-]+\/(import-preview|import)$/.test(path) ||
    /^\/api\/attempts\/[\w.:-]+\/ai-review$/.test(path)
  );
}
export function taskOperationTitle(operation: string): string {
  if (operation.includes('paper-plan')) return 'AI推荐题集';
  if (operation.startsWith('/api/ai/document-jobs/') && operation.endsWith('/plan'))
    return 'AI分块总结教材';
  if (operation.startsWith('/api/ai/document-jobs/') && operation.endsWith('/generate'))
    return 'AI根据教材生成题目';
  if (operation.includes('/maintenance/health')) return '数据库完整性检查';
  if (operation.includes('/migration') || operation.includes('backup.sqlite'))
    return 'SQLite数据迁移';
  if (operation.includes('/import-preview') || operation.includes('/packages/preview'))
    return '校验导入与查重';
  if (operation.endsWith('/import') && operation !== '/api/ai/import') return '导入数据包或题目';
  if (operation.includes('ai-review') || operation.endsWith('/ai/review')) return 'AI批量复核';
  if (operation.includes('/ai/')) return 'AI整理与分析';
  return '生成导出文件';
}
