import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyPushScheduler, dailyPushTimerDelay, dailyPushRefreshesAfter, type DailyPushSchedulerClock } from '../../server/scheduling/daily-push.js';
import { DEFAULT_DAILY_PUSH } from '../../shared/models/daily-push.js';
import { dailyCalendar, isDailyPushDue } from '../../server/modules/daily-push/calendar.js';
import { buildApp } from '../../server/index.js';

class FakeClock implements DailyPushSchedulerClock {
  private time: number; private serial = 0;
  readonly tasks = new Map<number, { at: number; run: () => void }>();
  constructor(value: string) { this.time = Date.parse(value); }
  now = () => new Date(this.time);
  setTimeout = (run: () => void, delay: number) => { const id = ++this.serial; this.tasks.set(id, { at: this.time + delay, run }); return id; };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  advance(milliseconds: number) {
    const until = this.time + milliseconds;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.tasks.delete(next[0]); this.time = next[1].at; next[1].run();
    }
    this.time = until;
  }
}

test('daily scheduler reaches local midnight exactly and resumes only the current date once', () => {
  const clock = new FakeClock('2026-10-24T15:59:59.900Z');
  const config = { ...DEFAULT_DAILY_PUSH, enabled: true };
  const dates = new Set<string>(); let checks = 0;
  const scheduler = createDailyPushScheduler({ readConfig: () => config, clock, check: at => { checks++; if (isDailyPushDue(config, at)) dates.add(dailyCalendar(at, config.timeZone).dateKey); } });
  assert.equal(dailyPushTimerDelay(clock.now(), config), 100);
  scheduler.refresh(); assert.deepEqual([...dates], ['2026-10-24']);
  clock.advance(99); assert.equal(dates.size, 1);
  clock.advance(1); assert.deepEqual([...dates], ['2026-10-24', '2026-10-25']);
  clock.advance(90000); assert.equal(dates.size, 2); assert.equal(clock.tasks.size, 1);
  const before = checks; scheduler.stop(); clock.advance(90000); assert.equal(checks, before); assert.equal(clock.tasks.size, 0);
});

test('disabled schedules keep no timer, configuration refresh reacts, and failures retry without re-entry', () => {
  const clock = new FakeClock('2026-10-24T04:44:59.500Z');
  let config = { ...DEFAULT_DAILY_PUSH, enabled: false, scheduleTime: '12:45' }; let checks = 0, failures = 0;
  let scheduler: ReturnType<typeof createDailyPushScheduler>;
  scheduler = createDailyPushScheduler({ readConfig: () => config, clock, check: () => { checks++; scheduler.refresh(); if (checks === 1) throw new Error('transient'); }, onError: () => failures++ });
  scheduler.refresh(); assert.equal(checks, 0); assert.equal(clock.tasks.size, 0);
  config = { ...config, enabled: true }; scheduler.refresh(); assert.equal(checks, 1); assert.equal(failures, 1); assert.equal(clock.tasks.size, 1);
  clock.advance(500); assert.equal(checks, 2); assert.equal(clock.tasks.size, 1);
  config = { ...config, enabled: false }; scheduler.refresh(); assert.equal(clock.tasks.size, 0); clock.advance(3600000); assert.equal(checks, 2);
  scheduler.stop();
  assert.equal(dailyPushRefreshesAfter('GET', '/api/bootstrap'), false);
  assert.equal(dailyPushRefreshesAfter('PUT', '/api/attempts/a'), false);
  assert.equal(dailyPushRefreshesAfter('PUT', '/api/settings'), true);
  assert.equal(dailyPushRefreshesAfter('POST', '/api/attempts/a/submit'), true);
});

test('real server startup/settings and midnight ticks create one persistent daily set; close releases timer', async t => {
  const clock = new FakeClock('2026-10-24T15:59:59.900Z');
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'no-daily-scheduler-assets', dailyPushSchedulerClock: clock });
  let closed = false; t.after(async () => { if (!closed) await app.close(); });
  const api = async (url: string, method: any = 'GET', payload?: unknown) => { const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) }); assert.ok(response.statusCode < 400, response.body); return response.json(); };
  await api('/api/import', 'POST', { mode: 'merge', data: { schemaVersion: 1, domains: [{ id: 'scheduler-domain', name: '调度范围', description: '', sortOrder: 0 }], categories: [{ id: 'scheduler-category', domainId: 'scheduler-domain', parentId: null, name: '基础', description: '', sortOrder: 0 }], tags: [], documents: [], papers: [], questions: Array.from({ length: 30 }, (_, index) => ({ id: `SCHEDULER-${index}`, title: `基础${index}`, stemMarkdown: '判断这个独立命题。', answerMarkdown: '正确', explanationMarkdown: '调度专用隔离数据', type: 'true_false', correctAnswers: ['true'], categoryIds: ['scheduler-category'], status: 'published' })) } });
  const settings = await api('/api/settings');
  await api('/api/settings', 'PUT', { settings: { ...settings, pointsByType: { ...settings.pointsByType, true_false: 2 }, dailyPush: { ...settings.dailyPush, enabled: true, domainId: 'scheduler-domain', categoryIds: ['scheduler-category'] } } });
  const today = await api('/api/daily-push'); assert.equal(today.today.dateKey, '2026-10-24'); assert.ok(today.today.totalPoints >= 50);
  clock.advance(100);
  const next = await api('/api/daily-push'); assert.equal(next.today.dateKey, '2026-10-25'); assert.equal(next.recent.length, 2);
  clock.advance(90000); assert.equal((await api('/api/daily-push')).recent.length, 2);
  await app.close(); closed = true; assert.equal(clock.tasks.size, 0);
});
