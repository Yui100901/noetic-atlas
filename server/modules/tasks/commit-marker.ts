/** Local receipts prevent replay after a crash between commit and task status updates. */
export const TASK_COMMIT_PREFIX = 'background_task:';

export function taskCommitKey(id: string): string {
  return TASK_COMMIT_PREFIX + id;
}
