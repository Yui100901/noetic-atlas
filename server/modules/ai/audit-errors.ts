import type { AiDiagnostics, AiFailure } from '../../../shared/ai/ai.js';
export const AI_AUDIT_HEADER = 'x-atlas-ai-audit-id';
export interface AuditedFailure { auditId: string; failure: AiFailure; diagnostics: AiDiagnostics }
const failures = new WeakMap<object, AuditedFailure>();
export function auditedFailure(error: unknown): AuditedFailure | undefined { return error && typeof error === 'object' ? failures.get(error) : undefined; }
export function markAuditedFailure(error: object, audit: AuditedFailure) { failures.set(error, audit); }
