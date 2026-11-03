import { useEffect, useState, type FormEvent, type InvalidEvent, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  type RetentionPreview,
  type SystemSettings,
} from '../../../shared/models/settings';
import { ApiError, localDate, send, useResource } from '../../shared/lib/api';
import { replaceHashRoute } from '../../shared/lib/navigation-guard';
import { ErrorNotice, Loading, Modal, useApp } from '../../shared/ui/components';
import { FormSaveBar } from '../../shared/ui/form-save-bar';
import { applyTheme, savedTheme } from '../../shared/theme/theme';
import { useDailyPush } from '../daily-push/daily-push';
import { SettingsFields, type SettingsSetter } from './settings-fields';
import {
  isSystemSettingsRoute,
  settingsHref,
  SETTINGS_SECTIONS,
  settingsSubsections,
  type SettingsRoute,
} from './settings-navigation';
import {
  changedSettingsSections,
  dailySettingsError,
  resetSettingsSection,
} from './settings-state';

/** Every ordinary category, including daily plans, uses this one saved version. */
export function useSystemSettingsDraft() {
  const resource = useResource<SystemSettings>('/api/settings'),
    { bootstrap, reload, toast } = useApp(),
    daily = useDailyPush();
  const [form, setForm] = useState<SystemSettings>(structuredClone(DEFAULT_SETTINGS));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retention, setRetention] = useState<RetentionPreview | null>(null);
  useEffect(() => {
    if (resource.data) setForm(structuredClone(resource.data));
  }, [resource.data]);
  useEffect(() => {
    if (resource.data) applyTheme(form.theme);
  }, [form.theme, resource.data]);
  useEffect(
    () => () => {
      applyTheme(savedTheme());
    },
    [],
  );
  const changed = resource.data ? changedSettingsSections(form, resource.data) : [];
  const externalSettings =
    bootstrap.settings && resource.data && bootstrap.settings.updatedAt > resource.data.updatedAt
      ? bootstrap.settings
      : null;
  useEffect(() => {
    if (externalSettings && !changed.length && !busy) resource.setData(externalSettings);
  }, [externalSettings, changed.length, busy, resource.setData]);
  const set: SettingsSetter = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }));
    setRetention(null);
  };
  const discard = () => {
    if (!resource.data || busy) return;
    const baseline = externalSettings || resource.data;
    resource.setData(baseline);
    setForm(structuredClone(baseline));
    setRetention(null);
    setError('');
  };
  const defaults = (route: SettingsRoute) => {
    if (busy) return;
    setForm((old) => resetSettingsSection(old, route));
    setRetention(null);
    setError('');
  };
  const save = async (confirmed = false) => {
    if (busy) return;
    if (externalSettings) {
      setError(
        '配置已在其他操作中更新，当前输入已保留。请先放弃当前配置修改以载入最新值，再重新编辑，避免覆盖刚导入的配置。',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await send<{ settings: SystemSettings; retention: RetentionPreview }>(
        '/api/settings',
        'PUT',
        {
          settings: form,
          ...(confirmed ? { confirmedRetention: true, expectedRetention: retention } : {}),
        },
      );
      resource.setData(result.settings);
      setForm(structuredClone(result.settings));
      applyTheme(result.settings.theme, { persist: true });
      setRetention(null);
      reload();
      // Recommendation refresh is advisory: a refresh error must not turn a
      // successful configuration write into a second, stale write on retry.
      void daily.refresh(true).catch(() => {});
      toast(
        result.retention.total
          ? `配置已保存，清理 ${result.retention.total} 份超限记录`
          : '系统配置已保存',
      );
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'RETENTION_CONFIRMATION_REQUIRED')
        setRetention(reason.details as RetentionPreview);
      else {
        setRetention(null);
        setError((reason as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    form,
    resource,
    busy,
    error,
    setError,
    retention,
    setRetention,
    externalSettings,
    changed,
    dirty: changed.length > 0,
    set,
    discard,
    defaults,
    save,
  };
}

export type SystemSettingsDraft = ReturnType<typeof useSystemSettingsDraft>;
export function SystemSettingsForm({
  draft,
  route,
}: {
  draft: SystemSettingsDraft;
  route: SettingsRoute;
}) {
  const { form, resource, busy, error, dirty, changed } = draft;
  const visible = isSystemSettingsRoute(route);
  let firstInvalid: HTMLInputElement | null = null;
  const invalid = (event: InvalidEvent<HTMLFormElement>) => {
    // Suppress native focus while a different category is hidden. Submission
    // reveals that category before focusing its first invalid control.
    event.preventDefault();
    if (!firstInvalid) firstInvalid = event.target as HTMLInputElement;
    let parent = (event.target as HTMLElement).parentElement;
    while (parent && parent !== event.currentTarget) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
  };
  const reveal = (target: SettingsRoute, field?: HTMLElement | null) => {
    replaceHashRoute(settingsHref(target.tab, target.sub));
    requestAnimationFrame(() => {
      field?.focus();
      field?.scrollIntoView({ block: 'center' });
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    firstInvalid = null;
    if (!event.currentTarget.reportValidity()) {
      const field = firstInvalid as HTMLInputElement | null;
      const owner = field?.closest<HTMLElement>('[data-settings-tab]');
      if (owner)
        reveal(
          {
            tab: owner.dataset.settingsTab as SettingsRoute['tab'],
            sub: owner.dataset.settingsSub || '',
          },
          field,
        );
      draft.setError(
        `请检查${field?.closest('label')?.textContent?.trim() || '标记的配置项'}，按要求填写后再保存。`,
      );
      return;
    }
    const dailyError = dailySettingsError(form.dailyPush);
    if (dailyError) {
      draft.setError(dailyError);
      reveal({ tab: 'review', sub: 'daily' });
      return;
    }
    void draft.save();
  };
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorNotice message={resource.error} retry={resource.refresh} />;
  const label = SETTINGS_SECTIONS.find((item) => item.id === route.tab)?.label;
  const subLabel = settingsSubsections(route.tab).find((item) => item.id === route.sub)?.label;
  return (
    <>
      <form
        className="settings-form ui-stack"
        id="system-settings-form"
        noValidate
        onSubmit={submit}
        onInvalidCapture={invalid}
        hidden={!visible}
      >
        <fieldset className="settings-fields ui-stack" disabled={busy}>
          <div className="settings-form-intro">
            <span className="muted">分区共用一份配置草稿，保存会一起提交其他分区的修改。</span>
            <button type="button" className="text-button" onClick={() => draft.defaults(route)}>
              <RotateCcw size={15} />
              填入{subLabel || label}默认值
            </button>
          </div>
          {error && <ErrorNotice message={error} />}
          {draft.externalSettings && (
            <div className="notice warning" role="status">
              已导入或更新配置。当前输入仍保留；请先放弃当前修改以载入最新值，再重新编辑。
            </div>
          )}
          <SettingsFields value={form} onChange={draft.set} route={route} busy={busy} />
        </fieldset>
        <FormSaveBar
          form="system-settings-form"
          label="系统配置保存操作"
          dirty={dirty}
          busy={busy}
          saveLabel="保存系统配置"
          onDiscard={draft.discard}
          discardLabel="放弃全部配置修改"
          status={
            <>
              <strong>
                {busy
                  ? '正在保存配置…'
                  : error
                    ? '保存未完成，请检查后重试'
                    : dirty
                      ? `${changed.length} 个分区有未保存修改`
                      : '系统配置已保存'}
              </strong>
              <small>
                {dirty
                  ? changed
                      .map(
                        (item) =>
                          settingsSubsections(item.tab).find((sub) => sub.id === item.sub)?.label ||
                          SETTINGS_SECTIONS.find((section) => section.id === item.tab)?.label,
                      )
                      .join('、')
                  : `最近保存 ${localDate(resource.data?.updatedAt)}`}
              </small>
            </>
          }
        />
      </form>
      {!visible && dirty && (
        <div className="notice info settings-pending-note" role="status">
          <span>系统配置有未保存修改，切换分区后会继续保留。</span>
          <a className="button" href={settingsHref(changed[0].tab, changed[0].sub)}>
            返回修改并保存
          </a>
        </div>
      )}
      {draft.retention && (
        <RetentionConfirmation
          value={draft.retention}
          busy={busy}
          onClose={() => draft.setRetention(null)}
          onConfirm={() => void draft.save(true)}
        />
      )}
    </>
  );
}

function RetentionConfirmation({
  value,
  busy,
  onClose,
  onConfirm,
}: {
  value: RetentionPreview;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const items: Array<[ReactNode, number | undefined]> = [
    ['作答草稿', value.drafts],
    ['整卷历史', value.history],
    ['单题详细历史', value.questionHistory],
    ['组题草稿', value.authoring],
    ['资料草稿', value.documentDrafts],
    ['题目草稿', value.questionDrafts],
    ['题目修订版本', value.questionRevisions],
    ['专注复习草稿', value.focusDrafts],
    ['专注复习总结', value.focusHistory],
  ];
  return (
    <Modal title="确认记录保留范围" onClose={() => !busy && onClose()}>
      <p>
        保存配置将清理 <strong>{value.total} 份</strong>超限记录，只保留各范围内最近的记录。
      </p>
      <ul>
        {items
          .filter(([, count]) => count)
          .map(([label, count], index) => (
            <li key={index}>
              {label}：{count} 份
            </li>
          ))}
      </ul>
      <p>
        整卷与单题历史分别保留；累计作答统计、错题状态与来源摘要、收藏、笔记、掌握和复习安排继续保留。清理不能从当前库撤销，可先取消并导出完整备份。
      </p>
      <div className="form-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="button primary" disabled={busy} onClick={onConfirm}>
          确认保存并清理记录
        </button>
      </div>
    </Modal>
  );
}
