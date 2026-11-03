import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  isSettingsNavigation,
  readSettingsRoute,
  settingsHref,
} from '../../web/features/settings/settings-navigation.js';
import {
  changedSettingsSections,
  dailySettingsError,
  resetSettingsSection,
} from '../../web/features/settings/settings-state.js';

test('settings deep links resolve established entry points and new nested categories', () => {
  assert.deepEqual(readSettingsRoute('#/settings'), { tab: 'general', sub: '' });
  assert.deepEqual(readSettingsRoute('#/settings?tab=practice'), { tab: 'practice', sub: '' });
  assert.deepEqual(readSettingsRoute('#/settings?tab=daily'), { tab: 'review', sub: 'daily' });
  assert.deepEqual(readSettingsRoute('#/settings?tab=backup'), { tab: 'backup', sub: 'backup' });
  assert.deepEqual(readSettingsRoute('#/data'), { tab: 'backup', sub: 'backup' });
  for (const sub of ['content', 'backup', 'configuration', 'health', 'cleanup', 'reset']) {
    assert.deepEqual(readSettingsRoute(settingsHref('backup', sub)), { tab: 'backup', sub });
  }
});

test('only recognized internal settings destinations bypass the unsaved guard', () => {
  for (const path of [
    '#/settings',
    '#/data',
    '#/settings?tab=ai',
    '#/settings?tab=assets&sub=files',
    '#/settings?tab=daily',
    '#/settings?tab=review&sub=scheduler',
  ])
    assert.equal(isSettingsNavigation(path), true, path);
  for (const path of [
    '#/settings/edit',
    '#/settings?tab=missing',
    '#/settings?tab=ai&sub=missing',
    '#/settings?tab=review&sub=unknown',
    '#/settings?redirect=home',
    '#/questions',
    '#/data?tab=ai',
  ])
    assert.equal(isSettingsNavigation(path), false, path);
});

test('section defaults preserve other drafts, history limits, learning goals and saved version', () => {
  const saved = structuredClone(DEFAULT_SETTINGS);
  const form = {
    ...saved,
    theme: 'pink' as const,
    examDurationMinutes: 15,
    maxQuestionHistory: 88,
    dailyPush: { ...saved.dailyPush, newPoints: 90 },
    updatedAt: '2026-11-03T00:00:00Z',
  };
  const reset = resetSettingsSection(form, { tab: 'practice', sub: '' });
  assert.equal(reset.examDurationMinutes, DEFAULT_SETTINGS.examDurationMinutes);
  assert.equal(reset.theme, 'pink');
  assert.equal(reset.maxQuestionHistory, 88);
  assert.equal(reset.dailyPush.newPoints, 90);
  assert.equal(reset.updatedAt, form.updatedAt);
  assert.equal(form.examDurationMinutes, 15);
  assert.deepEqual(resetSettingsSection(form, { tab: 'backup', sub: 'configuration' }), form);
});

test('one change summary accounts for nested plan and scoring edits without metadata noise', () => {
  const saved = structuredClone(DEFAULT_SETTINGS),
    draft = structuredClone(saved);
  draft.pointsByType.multiple_choice = 8;
  draft.dailyPush.newPoints = 50;
  draft.maxQuestionDrafts = 5;
  draft.updatedAt = '2026-11-03T00:00:00Z';
  assert.deepEqual(changedSettingsSections(draft, saved), [
    { tab: 'practice', sub: '' },
    { tab: 'review', sub: 'daily' },
    { tab: 'retention', sub: 'content' },
  ]);
});

test('daily enabled validation stays in the shared form before an API write', () => {
  const value = structuredClone(DEFAULT_SETTINGS.dailyPush);
  assert.equal(dailySettingsError(value), '');
  value.enabled = true;
  assert.ok(dailySettingsError(value));
  value.domainId = 'computer';
  value.categoryIds = ['basics'];
  assert.equal(dailySettingsError(value), '');
});
