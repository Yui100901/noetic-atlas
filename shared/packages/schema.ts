import { z } from 'zod';
import { dataPackageKinds, type DataPackageKind } from '../models/data-packages.js';
import type { PackageQuestionHashes } from './question-hashes.js';
export { dataPackageKinds, type DataPackageKind } from '../models/data-packages.js';

const MiB = 1024 * 1024;
export const DATA_PACKAGE_LIMITS = Object.freeze({
  maxBytes: 128 * MiB,
  maxExpandedBytes: 256 * MiB,
  maxFileBytes: 80 * MiB,
  maxFiles: 20000,
  maxPayloads: 256,
  maxManifestBytes: 2 * MiB,
});
export type DataPackageLimits = { [K in keyof typeof DATA_PACKAGE_LIMITS]: number };
export const SQLITE_PACKAGE_LIMITS: DataPackageLimits = Object.freeze({
  ...DATA_PACKAGE_LIMITS,
  maxBytes: 1024 * MiB,
  maxExpandedBytes: 1024 * MiB,
  maxFileBytes: 1024 * MiB - 4 * MiB,
});
export const packagePathIsSafe = (value: string) =>
  value.length <= 1024 &&
  !!value &&
  value.normalize('NFC') === value &&
  !value.startsWith('/') &&
  !/[\\:\u0000-\u001f\u007f]/.test(value) &&
  !value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part));
const pathSchema = z.string().refine(packagePathIsSafe, '包内路径无效');
const payloadSchema = z
  .object({
    path: pathSchema,
    domainIds: z.array(z.string().min(1).max(160)).max(10000).optional(),
  })
  .strict();
const fileSchema = z
  .object({
    path: pathSchema,
    mediaType: z.string().min(1).max(160),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const dataPackageManifestSchema = z
  .object({
    format: z.literal('noetic-atlas-package'),
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(160),
    kind: z.enum(dataPackageKinds),
    title: z.string().min(1).max(500),
    createdAt: z.string().datetime({ offset: true }),
    payloads: z.array(payloadSchema),
    files: z.array(fileSchema),
  })
  .strict();
export type DataPackageManifest = z.infer<typeof dataPackageManifestSchema>;
export interface DataPackagePayload {
  path: string;
  data: unknown;
  domainIds?: string[];
}
export interface DataPackageFile {
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
}
export interface DataPackageInput {
  kind: DataPackageKind;
  title: string;
  payloads: DataPackagePayload[];
  files?: DataPackageFile[];
  createdAt?: string;
  limits?: Partial<DataPackageLimits>;
}
export interface OpenedDataPackage extends PackageQuestionHashes {
  manifest: DataPackageManifest;
  payloads: DataPackagePayload[];
  files: Map<string, Uint8Array>;
}
export class DataPackageError extends Error {
  readonly code = 'INVALID_DATA_PACKAGE';
}
export const packageError = (message: string): never => {
  throw new DataPackageError(message);
};
export function packageLimits(values: Partial<DataPackageLimits> = {}): DataPackageLimits {
  const limits = { ...DATA_PACKAGE_LIMITS, ...values };
  if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1))
    packageError('数据包容量限制无效');
  return limits;
}
export function validateDataEnvelope(
  kind: DataPackageKind,
  data: unknown,
): asserts data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    packageError('数据分片必须是JSON对象');
  const value = data as Record<string, unknown>;
  const formats: Partial<Record<DataPackageKind, string>> = {
    share: 'learning-share',
    configuration: 'noetic-atlas-configuration',
    'question-template': 'learning-new-questions',
    'question-update': 'learning-pending-questions',
  };
  if (value.schemaVersion !== 1) packageError('数据分片版本不受支持');
  if (kind === 'migration') {
    if (
      Object.hasOwn(value, 'format') ||
      !Array.isArray(value.questions) ||
      !Array.isArray(value.domains)
    )
      packageError('迁移包与分片类型不一致；分享和新增题目不能作为可信迁移导入');
  } else if (kind === 'sqlite-backup' || value.format !== formats[kind]) {
    packageError('manifest用途与数据分片格式不一致');
  }
}
export function validateManifest(raw: unknown, limits: DataPackageLimits): DataPackageManifest {
  const parsed = dataPackageManifestSchema.safeParse(raw);
  if (!parsed.success) packageError('manifest.json格式或版本不受支持');
  const manifest = parsed.data!;
  if (manifest.files.length > limits.maxFiles || manifest.payloads.length > limits.maxPayloads)
    packageError('数据包文件或分片数量超过限制');
  const paths = new Set<string>(),
    payloads = new Set<string>();
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  let total = 0;
  for (const file of manifest.files) {
    const path = file.path.toLowerCase();
    if (path === 'manifest.json' || paths.has(path)) packageError('manifest包含重复或保留文件名');
    paths.add(path);
    if (file.byteLength > limits.maxFileBytes) packageError(`包内文件超过大小限制：${file.path}`);
    total += file.byteLength;
  }
  if (total > limits.maxExpandedBytes) packageError('数据包解压总量超过限制');
  for (const entry of manifest.payloads) {
    const file = files.get(entry.path);
    if (!file || file.mediaType !== 'application/json' || payloads.has(entry.path))
      packageError('manifest数据分片缺失、重复或类型无效');
    payloads.add(entry.path);
  }
  if (manifest.kind === 'sqlite-backup') {
    if (
      manifest.payloads.length ||
      manifest.files.filter((x) => x.mediaType === 'application/vnd.sqlite3').length !== 1
    )
      packageError('数据库包必须包含唯一SQLite文件且不包含JSON数据分片');
  } else if (!manifest.payloads.length) packageError('数据包没有可导入的数据分片');
  if (manifest.kind === 'configuration' && manifest.payloads.length !== 1)
    packageError('配置包只能包含一个配置分片');
  return manifest;
}
