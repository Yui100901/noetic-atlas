import { DEFAULT_SETTINGS, type SystemSettings } from '../../../shared/models/settings';
import type { SettingsRoute } from './settings-navigation';

const FIELD_GROUPS = [
  { tab: 'general', sub: '', fields: ['theme', 'autosaveDebounceMs'] },
  {
    tab: 'practice',
    sub: '',
    fields: [
      'examDurationMinutes',
      'randomQuestionCount',
      'scoringEnabledByDefault',
      'randomTotalPoints',
      'objectivePercent',
      'pointsByType',
    ],
  },
  { tab: 'review', sub: 'scheduler', fields: ['reviewScheduling', 'reviewIntervalsDays'] },
  { tab: 'review', sub: 'daily', fields: ['dailyPush'] },
  {
    tab: 'retention',
    sub: 'content',
    fields: ['maxPaperDrafts', 'maxDocumentDrafts', 'maxQuestionDrafts', 'maxQuestionRevisions'],
  },
  {
    tab: 'retention',
    sub: 'learning',
    fields: [
      'maxDraftsPerPaper',
      'maxQuickDrafts',
      'maxHistoryPerPaper',
      'maxQuickHistory',
      'maxQuestionHistory',
    ],
  },
  { tab: 'assets', sub: 'uploads', fields: ['maxDocumentMiB', 'maxImageMiB', 'aiImport'] },
] as const;

/** Reset only visible configuration. Hidden learning plans and limits survive. */
export function resetSettingsSection(form: SystemSettings, route: SettingsRoute): SystemSettings {
  const next = structuredClone(form),
    group = FIELD_GROUPS.find((item) => item.tab === route.tab && item.sub === route.sub);
  for (const field of group?.fields || [])
    Object.assign(next, { [field]: structuredClone(DEFAULT_SETTINGS[field]) });
  return next;
}

export function changedSettingsSections(
  form: SystemSettings,
  saved: SystemSettings,
): SettingsRoute[] {
  return FIELD_GROUPS.filter((group) =>
    group.fields.some((key) => JSON.stringify(form[key]) !== JSON.stringify(saved[key])),
  ).map(({ tab, sub }) => ({ tab, sub }));
}

export function dailySettingsError(form: SystemSettings['dailyPush']): string {
  if (form.enabled && !form.goals?.length && (!form.domainId || !form.categoryIds.length))
    return '开启每日推荐前，请选择领域和至少一个分类。';
  if (
    form.goals?.some(
      (goal) =>
        !goal.name.trim() || !goal.domainId || !goal.categoryIds.length || !goal.weekdays.length,
    )
  )
    return '请为每个学习目标填写名称、领域、至少一个分类及学习日期。';
  return '';
}
