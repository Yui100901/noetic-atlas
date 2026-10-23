import { DEFAULT_AI_SETTINGS, type AiSettings, type AiSettingsInput } from '../../../shared/ai/ai.js';
import { nextStamp, type Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { completionEndpoint, type PrivateAiSettings } from './provider.js';

export function readPrivateSettings(store: Store): PrivateAiSettings {
  const record = store.database.getRecord<PrivateAiSettings>('ai_settings', 'local');
  const { hasKey: _unused, ...defaults } = DEFAULT_AI_SETTINGS;
  return record || { ...defaults, key: '' };
}

export function getPublicAiSettings(store: Store): AiSettings {
  const { key, ...settings } = readPrivateSettings(store);
  return { ...settings, hasKey: Boolean(key) };
}

/** Input must first pass aiSettingsSchema (or the credential-free import schema). */
export function saveAiSettings(store: Store, input: AiSettingsInput): AiSettings {
  const previous = readPrivateSettings(store);
  if (input.updatedAt && input.updatedAt !== previous.updatedAt) fail(409, 'AI_SETTINGS_VERSION_CONFLICT', 'AI 配置已被修改，请刷新后保存');
  if (input.baseUrl) completionEndpoint(input.baseUrl);
  if (input.enabled && (!input.baseUrl || !input.model)) fail(400, 'AI_CONFIG_REQUIRED', '开启 AI 前请填写 API 地址和模型名称');
  const { clearKey, key, ...fields } = input;
  const next: PrivateAiSettings = { ...previous, ...fields, key: clearKey ? '' : key === undefined ? previous.key : key, updatedAt: nextStamp(previous.updatedAt) };
  store.database.putRecord('ai_settings', 'local', next);
  return getPublicAiSettings(store);
}
