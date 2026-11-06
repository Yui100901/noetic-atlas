import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Save, Sparkles, Unplug } from 'lucide-react';
import { request, send, useResource } from '../../shared/lib/api';
import type { AiSettingsView } from './ai-api';
import { ErrorNotice, Field, Loading, useApp } from '../../shared/ui/components';
import './ai.css';
import { AiProgressPanel, aiFailureMessage, useAiProgress } from './ai-progress';

export interface AiSettingsStatus {
  dirty: boolean;
  busy: boolean;
}
export function AiSettingsForm({
  active = true,
  refreshToken,
  onStatusChange,
}: {
  active?: boolean;
  refreshToken?: string;
  onStatusChange?: (status: AiSettingsStatus) => void;
} = {}) {
  const progress = useAiProgress();
  const resource = useResource<AiSettingsView>('/api/ai/settings');
  const { toast, reload } = useApp();
  const [externalSettings, setExternalSettings] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState<AiSettingsView | null>(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    // Only initialize here. A late read must not reset an input entered between
    // updating the resource baseline and running this passive effect.
    if (resource.data) setForm((current) => current || resource.data);
  }, [resource.data]);
  const dirty =
    !!form && (JSON.stringify(form) !== JSON.stringify(resource.data) || !!key || clearKey);
  const latest = useRef({ dirty, busy, stamp: form?.updatedAt });
  latest.current = { dirty, busy, stamp: form?.updatedAt };
  useEffect(() => {
    onStatusChange?.({ dirty, busy });
  }, [dirty, busy, onStatusChange]);
  useEffect(() => {
    if (!active || !resource.data) return;
    let cancelled = false;
    const requestedStamp = latest.current.stamp;
    void request<AiSettingsView>('/api/ai/settings')
      .then((value) => {
        if (cancelled || latest.current.busy) return;
        // Saving or explicitly adopting an external version invalidates a
        // previously started read, even if that read finishes after the save.
        if (latest.current.stamp !== requestedStamp && latest.current.stamp !== value.updatedAt)
          return;
        if (latest.current.dirty) {
          if (latest.current.stamp !== value.updatedAt) setExternalSettings(value);
        } else {
          resource.setData(value);
          setForm(value);
          setExternalSettings(null);
        }
      })
      .catch(() => {
        /* Initial loading and save present actionable failures. */
      });
    return () => {
      cancelled = true;
    };
  }, [active, refreshToken, !!resource.data, resource.setData]);
  const discard = () => {
    const saved = externalSettings || resource.data;
    if (!saved || busy) return;
    resource.setData(saved);
    setForm(saved);
    setKey('');
    setClearKey(false);
    setExternalSettings(null);
    setError('');
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || busy) return;
    if (externalSettings) {
      setError(
        'AI 配置已由导入或其他操作更新。当前输入已保留，请放弃 AI 修改以载入最新值，再重新编辑。',
      );
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { hasKey: _hasKey, ...settings } = form;
      const result = await send<AiSettingsView>('/api/ai/settings', 'PUT', {
        ...settings,
        ...(key.trim() ? { key: key.trim() } : {}),
        clearKey,
      });
      resource.setData(result);
      setForm(result);
      setKey('');
      setClearKey(false);
      setExternalSettings(null);
      reload();
      toast('AI辅助配置已保存');
    } catch (err) {
      setError(aiFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await progress.run<{ ok: boolean; message: string }>('/api/ai/test', {});
      setMessage(result.message || '连接成功');
    } catch (err) {
      setError(aiFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (resource.loading) return <Loading />;
  if (resource.error || !form)
    return <ErrorNotice message={resource.error || '配置读取失败'} retry={resource.refresh} />;
  return (
    <form className="ai-tools form-stack ai-settings-form" onSubmit={save}>
      <section className="card settings-section ai-settings-panel ui-stack">
        <div className="list-toolbar">
          <div>
            <h2>
              <Sparkles size={18} /> AI辅助
            </h2>
            <p className="muted">
              接入兼容 OpenAI Chat Completions 的服务。仅在主动运行 AI
              操作时发送所选题目、参考解析或作答。
            </p>
          </div>
          <div className="action-row">
            <button
              className="button"
              disabled={busy || (!dirty && !externalSettings)}
              type="button"
              onClick={discard}
            >
              放弃 AI 修改
            </button>
            <button className="button primary" disabled={busy} type="submit">
              <Save size={15} />
              {busy ? '正在保存…' : '保存 AI 配置'}
            </button>
          </div>
        </div>
        <AiProgressPanel value={progress.progress} cancel={progress.cancel} />
        {error && <ErrorNotice message={error} />}{' '}
        {externalSettings && (
          <div className="notice warning" role="status">
            AI 配置已更新，当前输入仍保留。请放弃 AI 修改以载入最新值，再重新编辑。
          </div>
        )}{' '}
        {message && (
          <div className="notice success" role="status">
            {message}
          </div>
        )}
        <label className="check-row">
          <input
            disabled={busy}
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          开启 AI 辅助功能
        </label>
        <div className="form-grid">
          <Field
            label="API 端点 / Base URL"
            hint="填写服务根地址或以 /v1 结尾的地址；支持本机或服务器上的兼容服务。HTTP会明文发送内容和凭据，请按服务环境选择。"
          >
            <input
              disabled={busy}
              required={form.enabled}
              type="url"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
          </Field>
          <Field label="模型名称">
            <input
              disabled={busy}
              required={form.enabled}
              maxLength={200}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="服务提供方的模型 ID"
            />
          </Field>
          <Field
            label="API Key / Token"
            hint={
              form.hasKey
                ? '已保存凭据。留空保留；填写新值替换。界面不会读取原值。'
                : '尚未保存凭据；无鉴权的本地服务可以留空。'
            }
          >
            <input
              disabled={busy}
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setClearKey(false);
              }}
              autoComplete="new-password"
              placeholder={form.hasKey ? '•••••••• 已保存（留空保留）' : '输入 Key 或 Token'}
            />
          </Field>
          <Field label="请求超时（秒）">
            <input
              disabled={busy}
              type="number"
              required
              min="5"
              max="180"
              value={form.timeoutSeconds}
              onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="最大输出 Token"
            hint="初始默认16384。这是单次输出上限，并非固定用量；完整字段修改或批量任务可适当增大，但不能超过模型支持范围。已有自定义值不会自动覆盖。"
          >
            <input
              disabled={busy}
              type="number"
              required
              min="256"
              max="32000"
              value={form.maxTokens}
              onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="check-row">
          <label>
            <input
              disabled={busy}
              type="checkbox"
              checked={clearKey}
              onChange={(e) => {
                setClearKey(e.target.checked);
                if (e.target.checked) setKey('');
              }}
            />
            保存时清除已有凭据
          </label>
          <label>
            <input
              disabled={busy}
              type="checkbox"
              checked={form.supportsImages}
              onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })}
            />
            模型支持图片输入
          </label>
          <label>
            <input
              disabled={busy}
              type="checkbox"
              checked={form.sendImages}
              onChange={(e) => setForm({ ...form, sendImages: e.target.checked })}
            />
            允许发送题目中的本地图片
          </label>
        </div>
        <p className="ai-request-note">
          图片仅在以上两项同时启用时发送。未发送图片时会提示信息缺失，AI审核不会自动通过有此风险的题目。凭据保存在本机数据库，分享包不包含凭据；完整
          SQLite 副本应自行妥善保管。
        </p>
        <div className="ai-actions">
          <button className="button" disabled={busy} type="button" onClick={() => void test()}>
            <Unplug size={15} />
            测试已保存的配置
          </button>
          <a className="button" href="#/ai">
            打开 AI 工作台
          </a>
        </div>
        <p className="muted">先保存再测试；测试会向所配置的服务发送一条简短请求。</p>
      </section>
    </form>
  );
}
