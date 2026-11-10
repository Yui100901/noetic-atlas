import { useId, useSyncExternalStore } from 'react';
import { Bell } from 'lucide-react';
import { terminalTask, type BackgroundTask } from '../../../shared/tasks/tasks';
import { getTasks, isTasksEnabled, subscribeTasks } from './client';
import './task-notification-button.css';

const emptyTasks: BackgroundTask[] = [];

export function TaskNotificationButton() {
  const tasks = useSyncExternalStore(subscribeTasks, getTasks, () => emptyTasks);
  const descriptionId = useId();
  if (!isTasksEnabled()) return null;
  const running = tasks.filter((task) => !terminalTask(task)).length;
  const unread = tasks.filter((task) => terminalTask(task) && !task.read).length;
  const count = running + unread;
  return (
    <a
      className={`task-notification-button${count ? ' has-notifications' : ''}`}
      href="#/tasks"
      aria-label="后台任务与通知"
      aria-describedby={descriptionId}
      title={`后台任务：${running} 项处理中，${unread} 项未读`}
    >
      <Bell size={19} aria-hidden="true" />
      {count > 0 && (
        <span className="task-notification-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
      <span className="sr-only" id={descriptionId}>
        {running} 项正在处理，{unread} 项未读结果
      </span>
    </a>
  );
}
