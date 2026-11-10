import { useEffect, useRef } from 'react';
import type { TaskInput, TaskResult } from '../../../shared/tasks/tasks';
import { getTask, isTasksEnabled, taskInput, waitForTaskResult } from './client';

/** A task result is applied only after draft selection, and only to the page
 * that requested it. It never silently replaces a different editor session. */
export function useTaskResume(
  operation: string,
  ready: boolean,
  restore: (input: TaskInput, result: TaskResult) => void,
  onError: (error: unknown) => void,
) {
  const callbacks = useRef({ restore, onError });
  callbacks.current = { restore, onError };
  const applied = useRef('');
  const id = new URLSearchParams(window.location.hash.split('?')[1]).get('backgroundTask') || '';
  useEffect(() => {
    if (!ready || !id || !isTasksEnabled() || applied.current === id) return;
    const controller = new AbortController();
    void (async () => {
      const task = await getTask(id, controller.signal);
      if (task.operation !== operation) return;
      const result = await waitForTaskResult(id, undefined, controller.signal);
      const input = await taskInput(id, controller.signal);
      if (!controller.signal.aborted) {
        applied.current = id;
        callbacks.current.restore(input, result);
      }
    })().catch((error) => {
      if (!controller.signal.aborted) callbacks.current.onError(error);
    });
    return () => controller.abort();
  }, [operation, ready, id]);
}
