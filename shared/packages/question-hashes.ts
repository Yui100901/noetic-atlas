import { z } from 'zod';
import type { QuestionInput } from '../models/types.js';
import {
  importDigest,
  importQuestionContent,
  importQuestionFeatures,
} from '../questions/import-dedup.js';
import type { DataPackagePayload } from './schema.js';

export const QUESTION_HASH_ALGORITHM = 'noetic-question-sha256-v1';
export const QUESTION_HASHES_PATH = 'metadata/question-hashes.json';

/** Portable cache hints, not proof that two independently supplied questions
 * are equal. Exact reuse still verifies their actual canonical content. */
export interface PackageQuestionHashHint {
  algorithm: typeof QUESTION_HASH_ALGORITHM;
  contentHash: string;
  promptHash?: string;
}
export interface PackageQuestionHashes {
  questionHashes?: ReadonlyMap<string, ReadonlyArray<PackageQuestionHashHint | undefined>>;
  questionHashAssets?: ReadonlyMap<string, string>;
}
export interface PackageQuestionHashSource {
  question: QuestionInput;
  hint?: PackageQuestionHashHint;
  assetKey: (id: string) => string;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sidecarSchema = z
  .object({
    format: z.literal('noetic-atlas-question-hashes'),
    schemaVersion: z.literal(1),
    algorithm: z.literal(QUESTION_HASH_ALGORITHM),
    payloads: z
      .array(
        z
          .object({
            path: z.string(),
            payloadSha256: digest,
            hashes: z.array(z.tuple([digest, digest]).nullable()).max(50000),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type QuestionHashSidecar = z.infer<typeof sidecarSchema>;

/** Enough room for two digests, JSON delimiters, one per-payload binding and
 * the fixed envelope. Export preview includes this derived metadata too. */
export const estimatedQuestionHashesBytes = (questions: number, payloads = 1) =>
  questions ? questions * 192 + payloads * 8192 + 1024 : 0;

export const questionHashAssetKey = (values?: ReadonlyMap<string, string>) => (id: string) =>
  values?.get(id) || `missing:${id}`;

export function questionHashesForPayload(
  questions: unknown[],
  assetKey: (id: string) => string,
): QuestionHashSidecar['payloads'][number]['hashes'] {
  return questions.map((value) => {
    // General template packaging may precede authoring validation. Invalid
    // editor rows remain invalid rows; an optional cache must not make them
    // look validated or prevent the normal field-level preview errors.
    if (!value || typeof value !== 'object') return null;
    const question = value as QuestionInput;
    if (
      typeof question.title !== 'string' ||
      typeof question.stemMarkdown !== 'string' ||
      typeof question.type !== 'string'
    )
      return null;
    try {
      return [
        importDigest(importQuestionContent(question, assetKey)),
        importQuestionFeatures(question).promptHash,
      ];
    } catch {
      return null;
    }
  });
}

/** Sidecars are optional, versioned caches. A file digest binds each row's
 * position to the exact source payload that was verified by the ZIP reader.
 * Old algorithms, malformed caches, changed payloads and count mismatches
 * fall back to normal computation without discarding otherwise valid data. */
export function readPackageQuestionHashes(
  raw: unknown,
  payloads: readonly DataPackagePayload[],
  descriptors: ReadonlyMap<string, { sha256: string }>,
): ReadonlyMap<string, ReadonlyArray<PackageQuestionHashHint | undefined>> {
  const result = new Map<string, Array<PackageQuestionHashHint | undefined>>();
  const parsed = sidecarSchema.safeParse(raw);
  if (!parsed.success) return result;
  const sources = new Map(payloads.map((part) => [part.path, part]));
  const seen = new Set<string>();
  for (const part of parsed.data.payloads) {
    if (seen.has(part.path)) return new Map();
    seen.add(part.path);
    const source = sources.get(part.path)?.data as Record<string, unknown> | undefined;
    if (
      !source ||
      !Array.isArray(source.questions) ||
      source.questions.length !== part.hashes.length ||
      descriptors.get(part.path)?.sha256 !== part.payloadSha256
    )
      continue;
    result.set(
      part.path,
      part.hashes.map((pair) =>
        pair
          ? {
              algorithm: QUESTION_HASH_ALGORITHM,
              contentHash: pair[0],
              promptHash: pair[1],
            }
          : undefined,
      ),
    );
  }
  return result;
}

/** Flatten before payload merging/Zod cloning, retaining the exact source
 * question so content transformations can invalidate the cached digest. */
export function packageQuestionHashSources(
  opened: PackageQuestionHashes & { payloads: readonly DataPackagePayload[] },
): PackageQuestionHashSource[] {
  const assetKey = questionHashAssetKey(opened.questionHashAssets);
  return opened.payloads.flatMap((part) => {
    const questions = (part.data as Record<string, unknown>).questions;
    const hints = opened.questionHashes?.get(part.path);
    if (!Array.isArray(questions)) return [];
    return questions.map((question, index) => ({
      question: question as QuestionInput,
      hint: hints?.[index],
      assetKey,
    }));
  });
}

/** Only hash-relevant content is compared. Metadata/taxonomy and local asset
 * ID remapping to identical validated bytes do not invalidate contentHash.
 * This saves SHA work, but deliberately keeps content validation. */
export function reusePackageQuestionHash(
  source: QuestionInput,
  current: QuestionInput,
  hint: PackageQuestionHashHint | undefined,
  sourceAssetKey: (id: string) => string,
  currentAssetKey: (id: string) => string,
): PackageQuestionHashHint | undefined {
  if (!hint || hint.algorithm !== QUESTION_HASH_ALGORITHM) return undefined;
  if (
    importQuestionContent(source, sourceAssetKey) !==
    importQuestionContent(current, currentAssetKey)
  )
    return undefined;
  // prompt_hash historically includes literal asset IDs. It is portable only
  // when the question's raw learning fields also stayed identical.
  return importQuestionContent(source) === importQuestionContent(current)
    ? hint
    : { algorithm: hint.algorithm, contentHash: hint.contentHash };
}
