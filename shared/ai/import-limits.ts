/** Local material budgets differ from the bounded text sent in one model call. */
export interface AiImportLimits {
  fileMiB: number;
  totalMiB: number;
  files: number;
  pdfPages: number;
  sourceCharacters: number;
  sourceMiB: number;
  blocks: number;
}
export const DEFAULT_AI_IMPORT_LIMITS: AiImportLimits = {
  fileMiB: 128,
  totalMiB: 256,
  files: 20,
  pdfPages: 5000,
  sourceCharacters: 8_000_000,
  sourceMiB: 24,
  blocks: 1200,
};
export const AI_IMPORT_HARD_LIMITS: AiImportLimits = {
  fileMiB: 256,
  totalMiB: 512,
  files: 50,
  pdfPages: 10000,
  sourceCharacters: 12_000_000,
  sourceMiB: 32,
  blocks: 2000,
};
export const AI_IMPORT_SINGLE_BYTES = 400_000;
export const AI_IMPORT_SINGLE_CHARACTERS = 400_000;
export const AI_IMPORT_REQUEST_BYTES = 80 * 1024 * 1024;
export const aiImportLimits = (input?: Partial<AiImportLimits>): AiImportLimits => ({
  ...DEFAULT_AI_IMPORT_LIMITS,
  ...input,
});
export const needsBatchedImport = (text: string) =>
  text.length > AI_IMPORT_SINGLE_CHARACTERS ||
  new TextEncoder().encode(text).length > AI_IMPORT_SINGLE_BYTES;
export function materialLimitMessage(limits: AiImportLimits) {
  return `${limits.sourceCharacters.toLocaleString()}字符／${limits.sourceMiB}MiB／${limits.blocks}块`;
}
