import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyticsInstantRange,
  readStatisticsLocation,
  statisticsLocation,
} from '../../web/features/analytics/statistics-navigation.js';
test('combined statistics defaults to this week and retains AI context when switching scopes', () => {
  const today = '2026-11-06';
  assert.equal(readStatisticsLocation('#/analytics', today, 'Asia/Shanghai').tab, 'learning');
  const current = readStatisticsLocation(
    '#/analytics?tab=ai&mode=all&run=run-1',
    today,
    'Asia/Shanghai',
  );
  assert.equal(current.allAi, true);
  const href = statisticsLocation({
    currentHash: '#/analytics?tab=ai&kind=grade&run=run-1',
    tab: 'learning',
    mode: 'week',
    anchor: today,
    custom: current.custom,
    allAi: false,
  });
  assert.ok(href.includes('tab=learning'));
  assert.ok(href.includes('run=run-1'));
});
test('AI calendar bounds use the configured zone including daylight saving days', () => {
  assert.deepEqual(
    analyticsInstantRange({ from: '2026-11-06', to: '2026-11-06' }, 'Asia/Shanghai'),
    { from: '2026-11-05T16:00:00.000Z', before: '2026-11-06T16:00:00.000Z' },
  );
  const value = analyticsInstantRange({ from: '2026-11-01', to: '2026-11-01' }, 'America/New_York');
  assert.equal((Date.parse(value.before) - Date.parse(value.from)) / 3600000, 25);
});
