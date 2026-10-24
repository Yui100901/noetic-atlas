import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConfigurationChange, ConfigurationExport, ConfigurationImportResult, ConfigurationPreview } from '../../../shared/models/configuration.js';
import { now, type Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { aiSettingsSchema } from '../ai/schema.js';
import { completionEndpoint } from '../ai/provider.js';
import { getPublicAiSettings, readPrivateSettings, saveAiSettings } from '../ai/settings.js';
import { getSettings, settingsSchema, settingsRetentionPlan, saveSettings } from './service.js';
import { validateDailyPushConfiguration } from '../daily-push/schema.js';

const { key: _key, clearKey: _clearKey, updatedAt: _updatedAt, ...portableAiFields } = aiSettingsSchema.shape;
export const portableAiSettingsSchema = z.object(portableAiFields).strict();
export const configurationSchema = z.object({
  format: z.literal('noetic-atlas-configuration'), schemaVersion: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  system: settingsSchema.omit({ id: true, updatedAt: true }),
  ai: portableAiSettingsSchema.optional(),
}).strict();
export const configurationPreviewInputSchema = z.object({ data: configurationSchema }).strict();
export const configurationImportInputSchema = configurationPreviewInputSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true), confirmedRetention: z.literal(true).optional(),
}).strict();
export const configurationExportQuerySchema = z.object({ includeAi: z.enum(['true', 'false']).default('true') }).strict();
export const configurationRetentionSchema = z.object({ drafts: z.number().int().nonnegative(), history: z.number().int().nonnegative(), authoring: z.number().int().nonnegative(), total: z.number().int().nonnegative(),questionHistory:z.number().int().nonnegative().optional() }).strict();
const changeSchema = z.object({ key: z.string(), before: z.unknown(), after: z.unknown() }).strict();
export const configurationPreviewSchema = z.object({
  fingerprint: z.string(), systemChanges: z.array(changeSchema), aiChanges: z.array(changeSchema), retention: configurationRetentionSchema,
  warnings: z.array(z.string()), aiKey: z.object({ action: z.enum(['unchanged', 'preserve', 'clear', 'missing']), message: z.string() }).strict(),
}).strict();
export const configurationImportResultSchema = z.object({ settings: settingsSchema, ai: z.object({ ...portableAiFields, updatedAt: z.string(), hasKey: z.boolean() }).strict(), retention: configurationRetentionSchema }).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function changes(before: Record<string, unknown>, after: Record<string, unknown>): ConfigurationChange[] {
  return Object.keys(after).filter(key => canonical(before[key]) !== canonical(after[key])).map(key => ({ key, before: before[key], after: after[key] }));
}
function systemFields(store: Store): ConfigurationExport['system'] {
  const { id: _id, updatedAt: _stamp, ...fields } = getSettings(store);
  return fields;
}
function aiFields(store: Store): NonNullable<ConfigurationExport['ai']> {
  // Positive field selection ensures future private fields cannot leak into exports.
  const settings = getPublicAiSettings(store);
  return parse(portableAiSettingsSchema, Object.fromEntries(Object.keys(portableAiFields).map(key => [key, settings[key as keyof typeof settings]])));
}
function validateAi(data: ConfigurationExport) {
  if (data.ai?.baseUrl) completionEndpoint(data.ai.baseUrl);
  if (data.ai?.enabled && (!data.ai.baseUrl || !data.ai.model)) fail(400, 'AI_CONFIG_REQUIRED', '开启 AI 前请填写 API 地址和模型名称');
}
function sameEndpoint(before: string, after: string) {
  if (!before || !after) return before === after;
  try { return completionEndpoint(before) === completionEndpoint(after); }
  catch { return false; }
}

export function exportConfiguration(store: Store, includeAi = true): ConfigurationExport {
  const data: ConfigurationExport = { format: 'noetic-atlas-configuration', schemaVersion: 1, exportedAt: now(), system: systemFields(store), ...(includeAi ? { ai: aiFields(store) } : {}) };
  validateAi(data);
  validateDailyPushConfiguration(store, data.system.dailyPush);
  return parse(configurationSchema, data);
}

export function previewConfiguration(store: Store, raw: unknown): ConfigurationPreview {
  const data = parse(configurationSchema, raw);
  validateAi(data);
  validateDailyPushConfiguration(store, data.system.dailyPush);
  const currentAi = readPrivateSettings(store);
  const retention = settingsRetentionPlan(store, { ...getSettings(store), ...data.system }).retention;
  const clearsKey = Boolean(data.ai && currentAi.key && !sameEndpoint(currentAi.baseUrl, data.ai.baseUrl));
  const action: ConfigurationPreview['aiKey']['action'] = !data.ai ? 'unchanged' : clearsKey ? 'clear' : currentAi.key ? 'preserve' : 'missing';
  const messages: Record<typeof action, string> = {
    unchanged: '文件不包含 AI 配置，本机 AI 配置和密钥保持不变。',
    preserve: '服务端点相同，保留本机已有密钥；配置文件不包含密钥。',
    clear: '服务端点发生变化，将清除本机旧密钥；请按新服务需要重新填写。',
    missing: '配置文件不包含密钥，本机目前也没有可保留的密钥。',
  };
  const warnings: string[] = [];
  if (retention.total) warnings.push(`导入后将按保留规则清理 ${retention.total} 条记录，必须另行确认。`);
  if (clearsKey) warnings.push(messages.clear);
  if (data.ai?.enabled && (clearsKey || !currentAi.key)) warnings.push('导入后 AI 将开启，但本机没有密钥。免密钥的本地服务可直接使用；其他服务请先补充密钥，再手动测试连接。');
  // Include the imported payload, both preference versions and every affected
  // record. Same-count replacements or edits must invalidate an old preview too.
  const fingerprint = createHash('sha256').update(canonical({
    data, system: getSettings(store), ai: currentAi,
    attempts: store.all('attempts').sort((a, b) => a.id.localeCompare(b.id)),
    paperDrafts: store.all('paper_drafts').sort((a, b) => a.id.localeCompare(b.id)),
    questionHistory:store.all('question_history').sort((a,b)=>a.id.localeCompare(b.id)),
  })).digest('hex');
  return {
    fingerprint, systemChanges: changes(systemFields(store), data.system), aiChanges: data.ai ? changes(aiFields(store), data.ai) : [],
    retention: { ...retention, authoring: retention.authoring || 0 }, warnings, aiKey: { action, message: messages[action] },
  };
}

export function importConfiguration(store: Store, raw: unknown): ConfigurationImportResult {
  const input = parse(configurationImportInputSchema, raw);
  return store.transaction(() => {
    const plan = previewConfiguration(store, input.data);
    if (input.fingerprint !== plan.fingerprint) fail(409, 'CONFIGURATION_PREVIEW_STALE', '配置或学习记录在预览后已变化，请重新预览后确认');
    if (plan.retention.total && !input.confirmedRetention) fail(409, 'RETENTION_CONFIRMATION_REQUIRED', '导入此配置会清理超出保留上限的记录，请单独确认', plan.retention);
    const saved = saveSettings(store, { ...getSettings(store), ...input.data.system }, { confirmedRetention: input.confirmedRetention, expectedRetention: plan.retention });
    const ai = input.data.ai ? saveAiSettings(store, { ...input.data.ai, clearKey: plan.aiKey.action === 'clear' }) : getPublicAiSettings(store);
    return { settings: saved.settings, ai, retention: plan.retention };
  });
}

export function registerConfigurationRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/settings/export', async request => {
    const query = parse(configurationExportQuerySchema, request.query);
    return exportConfiguration(store, query.includeAi === 'true');
  });
  app.post('/api/settings/import/preview', { bodyLimit: 1024 * 1024 }, async request => {
    const { data } = parse(configurationPreviewInputSchema, request.body);
    return previewConfiguration(store, data);
  });
  app.post('/api/settings/import', { bodyLimit: 1024 * 1024 }, async request => importConfiguration(store, request.body));
}
