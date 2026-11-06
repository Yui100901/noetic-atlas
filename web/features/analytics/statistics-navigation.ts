import { readAnalyticsLocation, shiftAnalyticsDay, validAnalyticsDay } from './range-navigation';
import { analyticsDateKey } from './report-export';

export type StatisticsTab = 'learning' | 'ai';

/** The same local date interval drives learning statistics and provider usage.
 * Find calendar boundaries instead of assuming every day lasts 24 hours. */
export function analyticsInstantRange(range: { from: string; to: string }, timeZone: string) {
  const start = (day: string) => {
    const approximate = Date.parse(day + 'T00:00:00Z');
    let low = approximate - 36 * 3600000,
      high = approximate + 36 * 3600000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (analyticsDateKey(new Date(middle), timeZone) < day) low = middle + 1;
      else high = middle;
    }
    return new Date(low).toISOString();
  };
  return { from: start(range.from), before: start(shiftAnalyticsDay(range.to, 1)) };
}

export function readStatisticsLocation(
  hash: string,
  today: string,
  timeZone: string,
  initialTab?: string,
) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const tab: StatisticsTab = (params.get('tab') || initialTab) === 'ai' ? 'ai' : 'learning';
  // Old AI record links used ISO instant bounds rather than calendar dates.
  const from = params.get('from') || '',
    before = params.get('before') || '';
  if (
    tab === 'ai' &&
    !params.has('mode') &&
    from &&
    !validAnalyticsDay(from) &&
    Number.isFinite(Date.parse(from))
  ) {
    params.set('mode', 'custom');
    params.set('from', analyticsDateKey(new Date(from), timeZone));
    if (before && Number.isFinite(Date.parse(before)))
      params.set('to', analyticsDateKey(new Date(Date.parse(before) - 1), timeZone));
  }
  return {
    ...readAnalyticsLocation('#/analytics?' + params, today),
    tab,
    allAi: tab === 'ai' && params.get('mode') === 'all',
  };
}

export function statisticsLocation(options: {
  currentHash: string;
  tab: StatisticsTab;
  mode: string;
  anchor: string;
  custom: { from: string; to: string };
  allAi: boolean;
}) {
  const params = new URLSearchParams(options.currentHash.split('?')[1] || '');
  for (const key of ['mode', 'date', 'from', 'to', 'before']) params.delete(key);
  params.set('tab', options.tab);
  params.set('mode', options.tab === 'ai' && options.allAi ? 'all' : options.mode);
  if (!(options.tab === 'ai' && options.allAi)) {
    if (options.mode === 'custom') {
      params.set('from', options.custom.from);
      params.set('to', options.custom.to);
    } else if (options.mode !== 'year') params.set('date', options.anchor);
  }
  return '#/analytics?' + params;
}
