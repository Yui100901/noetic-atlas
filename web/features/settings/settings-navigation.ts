/** Stable settings URLs are shared by navigation, validation and save guards. */
export const SETTINGS_SECTIONS = [
  { id: 'general', label: '外观与通用', description: '界面主题与自动保存' },
  { id: 'practice', label: '练习与计分', description: '组题分值与考试默认值' },
  { id: 'review', label: '复习与计划', description: '复习调度、每日推荐与学习目标' },
  { id: 'retention', label: '草稿与历史', description: '内容版本、草稿与作答保留' },
  { id: 'assets', label: '文件资源', description: '上传限制与已上传的文件' },
  { id: 'ai', label: 'AI 辅助', description: '模型连接、凭据与请求参数' },
  { id: 'backup', label: '数据与迁移', description: '整体／领域SQLite迁移与日常维护' },
] as const;

export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]['id'];
export interface SettingsRoute {
  tab: SettingsTab;
  sub: string;
}
export const SETTINGS_SUBSECTIONS = {
  review: [
    { id: 'scheduler', label: '复习调度' },
    { id: 'daily', label: '每日推荐与计划' },
  ],
  retention: [
    { id: 'content', label: '内容编辑与版本' },
    { id: 'learning', label: '学习草稿与作答' },
  ],
  assets: [
    { id: 'uploads', label: '上传限制' },
    { id: 'files', label: '文件管理' },
  ],
  backup: [
    { id: 'migration', label: '迁移' },
    { id: 'health', label: '数据健康' },
    { id: 'cleanup', label: '清理数据' },
    { id: 'reset', label: '重置学习进度' },
  ],
} as const;

export function settingsSubsections(tab: SettingsTab): readonly { id: string; label: string }[] {
  return tab in SETTINGS_SUBSECTIONS
    ? SETTINGS_SUBSECTIONS[tab as keyof typeof SETTINGS_SUBSECTIONS]
    : [];
}

export function readSettingsRoute(hash: string): SettingsRoute {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const requested = path === 'data' ? 'backup' : params.get('tab');
  if (requested === 'daily') return { tab: 'review', sub: 'daily' };
  const tab = SETTINGS_SECTIONS.some((item) => item.id === requested)
    ? (requested as SettingsTab)
    : 'general';
  const subsections = settingsSubsections(tab),
    rawSub = params.get('sub'),
    sub =
      tab === 'backup' && ['content', 'backup', 'configuration'].includes(rawSub || '')
        ? 'migration'
        : rawSub;
  return {
    tab,
    sub:
      subsections.find((item) => item.id === sub)?.id ||
      (tab === 'backup' ? 'migration' : subsections[0]?.id) ||
      '',
  };
}

export function settingsHref(tab: SettingsTab, sub?: string): string {
  const params = new URLSearchParams({ tab });
  if (sub) params.set('sub', sub);
  return `#/settings?${params}`;
}

/** Only real settings destinations may bypass unsaved-change confirmation. */
export function isSettingsNavigation(hash: string): boolean {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  if (path !== 'settings' && path !== 'data') return false;
  const params = new URLSearchParams(query),
    tab = params.get('tab');
  if ([...params.keys()].some((key) => !['tab', 'sub'].includes(key))) return false;
  if (path === 'data' && tab && tab !== 'backup') return false;
  if (tab && tab !== 'daily' && !SETTINGS_SECTIONS.some((item) => item.id === tab)) return false;
  const route = readSettingsRoute(hash),
    sub = params.get('sub');
  return (
    !sub ||
    (route.tab === 'backup' && ['content', 'backup', 'configuration'].includes(sub)) ||
    settingsSubsections(route.tab).some((item) => item.id === sub)
  );
}

export function isSystemSettingsRoute({ tab, sub }: SettingsRoute): boolean {
  return (
    ['general', 'practice', 'review', 'retention'].includes(tab) ||
    (tab === 'assets' && sub === 'uploads')
  );
}
