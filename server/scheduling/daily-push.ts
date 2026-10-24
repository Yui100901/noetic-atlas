import type { DailyPushSettings } from '../../shared/models/daily-push.js';
import { dailyCalendar } from '../modules/daily-push/calendar.js';

/** Bounded checks also recover from suspended timers, clock adjustments and
 * daylight-saving changes. Shorten the next wait at the configured wall time. */
export function dailyPushTimerDelay(at: Date, config: Pick<DailyPushSettings, 'scheduleTime' | 'timeZone'>): number {
  const local = dailyCalendar(at, config.timeZone), [hour, minute] = local.time.split(':').map(Number);
  const [targetHour, targetMinute] = config.scheduleTime.split(':').map(Number);
  const phase = ((hour! * 60 + minute!) * 60 + at.getUTCSeconds()) * 1000 + at.getUTCMilliseconds();
  const target = (targetHour! * 60 + targetMinute!) * 60000;
  const until = (target - phase + 86400000) % 86400000;
  return Math.max(1, Math.min(30000, until || 86400000));
}

export interface DailyPushSchedulerClock {
  now(): Date;
  setTimeout(run: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const dailyPushSystemClock: DailyPushSchedulerClock = {
  now: () => new Date(),
  setTimeout: (run, delay) => globalThis.setTimeout(run, delay),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
function unref(handle: unknown) {
  if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
}

/** The server owns synchronous SQLite writes. Native callers use the same
 * delay calculation, but commit through their serialized durable API queue. */
export function createDailyPushScheduler(options: {
  readConfig(): DailyPushSettings;
  check(at: Date): unknown;
  clock?: DailyPushSchedulerClock;
  onError?(error: unknown): void;
}) {
  const clock = options.clock || dailyPushSystemClock;
  let timer: unknown, stopped = false, checking = false;
  const clear = () => { if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; } };
  const refresh = () => {
    if (stopped || checking) return;
    clear(); checking = true;
    let config: DailyPushSettings | undefined;
    try { config = options.readConfig(); if (config.enabled) options.check(clock.now()); }
    catch (error) { options.onError?.(error); }
    finally {
      checking = false;
      if (!stopped && config?.enabled) {
        let delay = 30000;
        try { delay = dailyPushTimerDelay(clock.now(), config); } catch (error) { options.onError?.(error); }
        timer = clock.setTimeout(refresh, delay); unref(timer);
      }
    }
  };
  return { refresh, stop() { stopped = true; clear(); } };
}

/** Only writes that can change scheduling or end an exam need a wake-up.
 * Ordinary GETs, notes and answer autosaves do not scan the question pool. */
export function dailyPushRefreshesAfter(method: string, pathname: string): boolean {
  return method === 'PUT' && pathname === '/api/settings'
    || method === 'POST' && (pathname === '/api/settings/import' || pathname === '/api/import'
      || pathname === '/api/exams/sync' || /^\/api\/attempts\/[^/]+\/(?:submit|sync)$/.test(pathname));
}
