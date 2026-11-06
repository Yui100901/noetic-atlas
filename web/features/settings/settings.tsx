import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { PageHeader, useApp } from '../../shared/ui/components';
import { useNavigationGuard } from '../../shared/lib/navigation-guard';
import { AiSettingsForm, type AiSettingsStatus } from '../ai/ai-settings';
import { LearningPlanHistory } from '../daily-push/learning-plan-history';
import { AssetsManager } from './settings-assets';
import { SystemSettingsForm, useSystemSettingsDraft } from './settings-form';
import { DataPage } from './data';
import { DataMaintenance } from './maintenance';
import {
  isSettingsNavigation,
  readSettingsRoute,
  settingsHref,
  SETTINGS_SECTIONS,
  settingsSubsections,
} from './settings-navigation';
import './settings-layout.css';

export function SettingsPage({ hash }: { hash: string }) {
  const route = readSettingsRoute(hash),
    draft = useSystemSettingsDraft(),
    { bootstrap, toast } = useApp();
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus>({ dirty: false, busy: false });
  const [visitedAi, setVisitedAi] = useState(route.tab === 'ai');
  const subTabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (route.tab === 'ai') setVisitedAi(true);
  }, [route.tab]);
  useEffect(() => {
    const tabs = subTabsRef.current;
    const selected = tabs?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!tabs || !selected) return;
    // Keep deep-linked and newly selected tabs visible without scrolling the
    // page vertically, including after a narrow-screen resize or font load.
    const reveal = () => {
      const viewport = tabs.getBoundingClientRect(),
        item = selected.getBoundingClientRect();
      if (item.left < viewport.left) tabs.scrollLeft += item.left - viewport.left;
      else if (item.right > viewport.right) tabs.scrollLeft += item.right - viewport.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(tabs);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [route.tab, route.sub]);
  useNavigationGuard({
    pending: () => draft.dirty || aiStatus.dirty,
    saving: () => draft.busy || aiStatus.busy,
    // Only two routes belonging to this preserved settings session may switch
    // without confirmation. Unknown destinations use a fresh router boundary.
    allowNavigation: (next) => isSettingsNavigation(hash) && isSettingsNavigation(next),
    confirmLeave: () => window.confirm('系统配置有未保存修改，确定放弃修改并离开？'),
    onBusy: () => toast('配置正在保存或测试，请稍后再离开。', true),
  });
  const section = SETTINGS_SECTIONS.find((item) => item.id === route.tab)!;
  const subsections = settingsSubsections(route.tab);
  return (
    <div className="settings-page">
      <PageHeader
        eyebrow="SYSTEM SETTINGS"
        title="系统配置"
        description="按用途管理学习偏好、内容保留、AI 服务与数据。"
      />
      <div className="settings-shell">
        <nav className="settings-tabs" aria-label="系统配置分区">
          {SETTINGS_SECTIONS.map((item) => (
            <a
              key={item.id}
              href={settingsHref(item.id)}
              className={route.tab === item.id ? 'selected' : ''}
              aria-current={route.tab === item.id ? 'page' : undefined}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <ChevronRight size={15} />
            </a>
          ))}
        </nav>
        <div className="settings-content ui-stack">
          <div className="settings-category-heading">
            <h2>{section.label}</h2>
            <p className="muted">{section.description}</p>
          </div>
          {subsections.length > 0 && (
            <nav ref={subTabsRef} className="settings-subtabs" aria-label={`${section.label}分类`}>
              {subsections.map((item) => (
                <a
                  className={route.sub === item.id ? 'selected' : undefined}
                  key={item.id}
                  href={settingsHref(route.tab, item.id)}
                  aria-current={route.sub === item.id ? 'page' : undefined}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          )}
          <SystemSettingsForm draft={draft} route={route} />
          {route.tab === 'review' && route.sub === 'daily' && <LearningPlanHistory />}
          {route.tab === 'assets' && route.sub === 'files' && <AssetsManager />}
          {visitedAi && (
            <div className="settings-panel" hidden={route.tab !== 'ai'}>
              <AiSettingsForm
                active={route.tab === 'ai'}
                refreshToken={bootstrap.settings?.updatedAt}
                onStatusChange={setAiStatus}
              />
            </div>
          )}
          {route.tab === 'backup' &&
            (route.sub === 'migration' ? (
              <DataPage key={route.sub} embedded />
            ) : (
              <DataMaintenance key={route.sub} view={route.sub as 'health' | 'cleanup' | 'reset'} />
            ))}
        </div>
      </div>
    </div>
  );
}
