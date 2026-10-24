import type { DailyPushSettings } from '../../../shared/models/daily-push.js';

export function dailyCalendar(at: Date, timeZone: string): { dateKey: string; time: string } {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid daily-push clock');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
export function isDailyPushDue(config: DailyPushSettings, at: Date): boolean { return config.enabled && dailyCalendar(at, config.timeZone).time >= config.scheduleTime; }
export function nextDateKey(config: DailyPushSettings, at: Date, alreadyGenerated: boolean): string {
  const { dateKey, time } = dailyCalendar(at, config.timeZone);
  if (!alreadyGenerated || time < config.scheduleTime) return dateKey;
  const tomorrow = new Date(dateKey + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); return tomorrow.toISOString().slice(0, 10);
}
