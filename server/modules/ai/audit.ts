import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AiDiagnostics, AiFailure, AiProviderAttempt, AiRun, AiRunKind } from '../../../shared/ai/ai.js';
import type { AiExecutionContext } from '../../../shared/ai/ai-progress.js';
import { ApiError } from '../../core/validation.js';
import { makeId, now, type Store } from '../../core/store.js';
import { runAiAction } from './execution.js';
import { aiFailureSchema } from './audit-schema.js';
import { AI_AUDIT_HEADER, auditedFailure, markAuditedFailure } from './audit-errors.js';
export { AI_AUDIT_HEADER, auditedFailure, type AuditedFailure } from './audit-errors.js';
export interface AiAuditMetadata {
  jobId?: string; batchId?: string; feedbackId?: string; questionIds?: string[]; attemptId?: string;
  onComplete?(diagnostics: AiDiagnostics): void;
}
const phase = (value: unknown, fallback = 'processing') => typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,100}$/.test(value) ? value : fallback;
function failureAdvice(code: string, httpStatus?: number) {
  if (httpStatus === 401 || httpStatus === 403) return '检查服务端点、API密钥和账号权限后重试。';
  if (httpStatus === 404) return '检查服务端点路径和模型名称是否受该服务支持。';
  if (httpStatus === 429) return '服务请求过于频繁或额度不足，请检查额度，降低并发并稍后重试。';
  if (httpStatus && httpStatus >= 500) return '模型服务暂时异常，请稍后重试当前失败批次。';
  if (code === 'AI_TIMEOUT') return '减少当前批次内容或题量，或在设置中提高请求超时后重试。';
  if (code === 'AI_OUTPUT_TRUNCATED') return '减少当前批次题量，或提高输出token上限后重试；截断结果不可应用。';
  if (code === 'AI_INVALID_JSON' || code === 'AI_EMPTY_RESPONSE') return '模型未给出完整合法JSON，可重试当前批次；持续失败时减少题量或更换模型。';
  if (code === 'AI_INVALID_OUTPUT') return '按问题字段核对题型和输出结构，减少题量或明确要求后重试。';
  if (code === 'AI_CANCELLED') return '本次处理已停止，可保留已有完整结果，稍后重新发起。';
  if (code.includes('VERSION_CONFLICT')) return '原题或作答已变化，刷新并基于最新内容重新分析。';
  if (code === 'AI_IMPORT_NO_QUESTIONS') return '若材料是教材正文，请选择教材知识出题；否则补充完整题目材料。';
  if (code === 'AI_REFUSED') return '模型拒绝了当前任务，请核对材料和任务范围后调整要求。';
  return '核对当前批次材料、题型和要求后重试；已保存的其他批次无需重复处理。';
}
/** Unknown exceptions never contribute their messages or response bodies. */
export function aiFailureFromError(error: unknown, diagnostics?: AiDiagnostics): AiFailure {
  const known = error instanceof ApiError && /^AI_[A-Z0-9_]+$/.test(error.code);
  const details = known && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const code = known ? error.code : 'AI_PROCESSING_FAILED';
  const message = known ? error.message.slice(0, 1800) : 'AI任务未完成，内部处理出现错误；未保存本次结果。';
  const raw = { code, message, stage: diagnostics?.stage || 'processing',
    retryable: !['AI_CANCELLED', 'AI_REFUSED', 'AI_QUESTION_VERSION_CONFLICT', 'AI_ATTEMPT_VERSION_CONFLICT'].includes(code),
    recommendation: failureAdvice(code, diagnostics?.httpStatus), ...(known ? { statusCode: error.status } : {}),
    ...(details.jsonLocation ? { jsonLocation: details.jsonLocation } : {}),
    ...(details.validationIssues ? { validationIssues: details.validationIssues } : {}),
  };
  const parsed = aiFailureSchema.safeParse(raw);
  return parsed.success ? parsed.data : { code, message, stage: diagnostics?.stage || 'processing', retryable: true, recommendation: failureAdvice(code, diagnostics?.httpStatus), ...(known ? { statusCode: error.status } : {}) };
}

export async function auditAiOperation<T>(store: Store, kind: AiRunKind, operation: (context?: AiExecutionContext) => Promise<T>, base?: AiExecutionContext, metadata: AiAuditMetadata = {}): Promise<T> {
  const startedAt = now(), started = Date.now();
  const attempts: AiProviderAttempt[] = []; let calls = 0, totalInput = 0, finishedOutput = 0, stage = 'preparing', model = '';
  let current: AiProviderAttempt | undefined;
  const context: AiExecutionContext = { signal: base?.signal, streaming: base ? base.streaming !== false : false,
    emit(event) { if (event.type === 'status') stage = phase(event.stage); base?.emit(event); },
    telemetry(event) {
      base?.telemetry?.(event);
      if (event.type === 'provider_start') {
        calls++; totalInput += event.inputBytes; model = event.model.slice(0, 200);
        current = { index: calls, startedAt: now(), phase: 'request', inputBytes: event.inputBytes, outputBytes: 0 };
        attempts.push(current); if (attempts.length > 200) attempts.shift(); stage = 'model_request';
      } else if (event.type === 'provider_update' && current) {
        if (event.phase) { current.phase = phase(event.phase); stage = current.phase; }
        if (event.outputBytes !== undefined) current.outputBytes = Math.max(0, event.outputBytes);
        if (event.httpStatus !== undefined) current.httpStatus = event.httpStatus;
        if (event.finishReason !== undefined) current.finishReason = event.finishReason;
      } else if (event.type === 'provider_end' && current) {
        current.finishedAt = now(); current.durationMs = Math.max(0, Date.now() - Date.parse(current.startedAt));
        current.status = event.ok ? 'completed' : 'failed'; if (event.code) current.code = phase(event.code, 'AI_PROCESSING_FAILED');
        finishedOutput += current.outputBytes;
      }
    },
  };
  const diagnostics = (): AiDiagnostics => ({ startedAt, finishedAt: now(), durationMs: Math.max(0, Date.now() - started), stage,
    providerCalls: calls, inputBytes: totalInput, outputBytes: finishedOutput + (current?.status ? 0 : current?.outputBytes || 0),
    ...(current?.httpStatus !== undefined ? { httpStatus: current.httpStatus } : {}), ...(current?.finishReason ? { finishReason: current.finishReason } : {}), attempts });
  try {
    const result = await operation(context);
    if (calls) {
      const value = diagnostics(); metadata.onComplete?.(value);
      if (result && typeof result === 'object' && 'id' in result && 'status' in result && result.status === 'completed') {
        const run = store.database.getRecord<AiRun<any>>('ai_runs', String(result.id));
        if (run?.status === 'completed') { const next = { ...run, diagnostics: value }; store.database.putRecord('ai_runs', run.id, next); return { ...result, diagnostics: value }; }
      }
    }
    return result;
  } catch (reason) {
    if (!calls) throw reason;
    if (auditedFailure(reason)) throw reason;
    if (stage === 'validated') stage = 'business_validation';
    const value = diagnostics(), failure = aiFailureFromError(reason, value), auditId = makeId('ai');
    const run: AiRun = { id: auditId, kind, status: failure.code === 'AI_CANCELLED' ? 'cancelled' : 'failed', createdAt: startedAt, model, warnings: [],
      questionIds: metadata.questionIds || [], ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
      ...(metadata.jobId ? { jobId: metadata.jobId } : {}), ...(metadata.batchId ? { batchId: metadata.batchId } : {}), ...(metadata.feedbackId ? { feedbackId: metadata.feedbackId } : {}), failure, diagnostics: value };
    store.database.putRecord('ai_runs', auditId, { ...run, _context: { questionVersions: {}, sourceByItem: {} } });
    const error = new ApiError(failure.statusCode || 500, failure.code, failure.message);
    const audit = { auditId, failure, diagnostics: value }; markAuditedFailure(error, audit);
    error.details = audit; throw error;
  }
}

export function runAuditedAiAction<T>(store: Store, kind: AiRunKind, request: FastifyRequest, reply: FastifyReply, operation: (context?: AiExecutionContext) => Promise<T>, options: { native?: boolean } = {}) {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
  const cleanId = (value: unknown) => typeof value === 'string' && /^[\p{L}\p{N}_.:-]{1,322}$/u.test(value) ? value : undefined;
  const questionIds = Array.isArray(body.questionIds) ? body.questionIds.map(cleanId).filter((value): value is string => !!value).slice(0, 500) : cleanId(body.questionId) ? [String(body.questionId)] : [];
  const attemptId = cleanId(body.attemptId) || (request.url.startsWith('/api/attempts/') ? cleanId((request.params as Record<string, unknown>).id) : undefined);
  return runAiAction(request, reply, async context => {
    try { return await auditAiOperation(store, kind, operation, context, { questionIds, ...(attemptId ? { attemptId } : {}) }); }
    catch (error) { const audit = auditedFailure(error); if (audit && !reply.raw?.headersSent) reply.header(AI_AUDIT_HEADER, audit.auditId); throw error; }
  }, options);
}
