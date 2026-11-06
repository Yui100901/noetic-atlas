import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64 } from '../assets/assets.js';
import { createCompressedZip } from '../exports/zip.js';
import { readPackageArchive } from './archive-reader.js';
import {
  QUESTION_HASH_ALGORITHM,
  QUESTION_HASHES_PATH,
  questionHashAssetKey,
  questionHashesForPayload,
  readPackageQuestionHashes,
  type QuestionHashSidecar,
} from './question-hashes.js';
import {
  packageError,
  packageLimits,
  packagePathIsSafe,
  validateDataEnvelope,
  validateManifest,
  type DataPackageInput,
  type DataPackageLimits,
  type DataPackageManifest,
  type DataPackagePayload,
  type OpenedDataPackage,
} from './schema.js';
export {
  DATA_PACKAGE_LIMITS,
  SQLITE_PACKAGE_LIMITS,
  DataPackageError,
  dataPackageKinds,
  dataPackageManifestSchema,
  type DataPackageKind,
  type DataPackageLimits,
  type DataPackageManifest,
  type DataPackagePayload,
  type DataPackageFile,
  type DataPackageInput,
  type OpenedDataPackage,
} from './schema.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export async function packageSha256(bytes: Uint8Array): Promise<string> {
  // WebCrypto is unavailable on plain HTTP LAN deployments. Hashes have the
  // same wire representation in the fallback and across all platforms.
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
      )
    : sha256(bytes);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}
function packageId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}
function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return packageError(`包内JSON无法解析：${path}`);
  }
}
/** Binary assets are content-addressed and shared between all JSON partitions. */
export async function buildDataPackage(input: DataPackageInput): Promise<Uint8Array> {
  const limits = packageLimits(input.limits);
  const files = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const folded = new Set<string>();
  const digests = new Map<string, string>();
  const assetIdentities = new Map<string, string>();
  const ambiguousAssets = new Set<string>();
  const hashPayloads: Array<{ path: string; questions: unknown[]; payloadSha256: string }> = [];
  let total = 0;
  const add = (path: string, bytes: Uint8Array, mediaType: string) => {
    if (
      !packagePathIsSafe(path) ||
      path.toLowerCase() === 'manifest.json' ||
      folded.has(path.toLowerCase())
    )
      packageError(`重复或无效文件路径：${path}`);
    if (bytes.length > limits.maxFileBytes) packageError(`包内文件超过大小限制：${path}`);
    if (files.size >= limits.maxFiles || (total += bytes.length) > limits.maxExpandedBytes)
      packageError('数据包解压总量或文件数量超过限制');
    files.set(path, { bytes, mediaType });
    folded.add(path.toLowerCase());
  };
  if (input.payloads.length > limits.maxPayloads) packageError('数据包分片数量超过限制');
  for (const file of input.files || []) {
    // A copied cache is never authoritative for an edited/repacked payload.
    // This producer regenerates its derived metadata from the actual inputs.
    if (file.path.toLowerCase() === QUESTION_HASHES_PATH) continue;
    add(file.path, file.bytes, file.mediaType || 'application/octet-stream');
  }
  const payloads: DataPackageManifest['payloads'] = [];
  for (const part of input.payloads) {
    validateDataEnvelope(input.kind, part.data);
    const data = { ...part.data };
    if (Array.isArray(data.assets)) {
      const assets = [];
      for (const item of data.assets) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof item.dataBase64 !== 'string' ||
          typeof item.mimeType !== 'string'
        )
          packageError('附件记录格式无效');
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(item.dataBase64);
        } catch {
          return packageError('附件Base64无法解析');
        }
        const digest = await packageSha256(bytes);
        if (typeof item.id === 'string') {
          const key = `${item.mimeType}:${digest}`;
          if (assetIdentities.has(item.id) && assetIdentities.get(item.id) !== key) {
            ambiguousAssets.add(item.id);
            assetIdentities.delete(item.id);
          }
          if (!ambiguousAssets.has(item.id)) assetIdentities.set(item.id, key);
        }
        const extension =
          (
            {
              'image/png': 'png',
              'image/jpeg': 'jpg',
              'image/webp': 'webp',
              'image/gif': 'gif',
              'application/pdf': 'pdf',
              'text/markdown': 'md',
            } as Record<string, string>
          )[item.mimeType] || 'bin';
        const path = `assets/${digest}.${extension}`;
        if (!files.has(path)) add(path, bytes, item.mimeType);
        else if (
          files.get(path)!.mediaType !== item.mimeType ||
          (digests.get(path) || (await packageSha256(files.get(path)!.bytes))) !== digest
        )
          packageError('附件路径与内容冲突');
        digests.set(path, digest);
        const { dataBase64: _bytes, ...metadata } = item;
        assets.push({ ...metadata, packagePath: path });
      }
      data.assets = assets;
    }
    const bytes = encoder.encode(JSON.stringify(data));
    add(part.path, bytes, 'application/json');
    if (Array.isArray(part.data.questions) && part.data.questions.length) {
      const payloadSha256 = await packageSha256(bytes);
      digests.set(part.path, payloadSha256);
      hashPayloads.push({ path: part.path, questions: part.data.questions, payloadSha256 });
    }
    payloads.push({ path: part.path, ...(part.domainIds ? { domainIds: part.domainIds } : {}) });
  }
  if (hashPayloads.length) {
    const assetKey = questionHashAssetKey(assetIdentities);
    const sidecar: QuestionHashSidecar = {
      format: 'noetic-atlas-question-hashes',
      schemaVersion: 1,
      algorithm: QUESTION_HASH_ALGORITHM,
      payloads: hashPayloads.map(part => ({
        path: part.path,
        payloadSha256: part.payloadSha256,
        hashes: questionHashesForPayload(part.questions, assetKey),
      })),
    };
    add(QUESTION_HASHES_PATH, encoder.encode(JSON.stringify(sidecar)), 'application/json');
  }
  const records = [];
  for (const [path, file] of files)
    records.push({
      path,
      mediaType: file.mediaType,
      byteLength: file.bytes.length,
      sha256: digests.get(path) || (await packageSha256(file.bytes)),
    });
  const manifest = validateManifest(
    {
      format: 'noetic-atlas-package',
      schemaVersion: 1,
      id: packageId(),
      kind: input.kind,
      title: input.title,
      createdAt: input.createdAt || new Date().toISOString(),
      payloads,
      files: records,
    },
    limits,
  );
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > limits.maxManifestBytes) packageError('manifest.json超过大小限制');
  try {
    return createCompressedZip(
      [
        { name: 'manifest.json', bytes: manifestBytes },
        ...Array.from(files, ([name, file]) => ({ name, bytes: file.bytes })),
      ],
      limits.maxBytes,
      limits.maxExpandedBytes + limits.maxManifestBytes,
    );
  } catch (reason) {
    return packageError((reason as Error).message);
  }
}

export async function readDataPackage(
  bytes: Uint8Array,
  overrides: Partial<DataPackageLimits> = {},
): Promise<OpenedDataPackage> {
  const limits = packageLimits(overrides),
    files = readPackageArchive(bytes, limits);
  const raw = files.get('manifest.json');
  if (!raw) packageError('缺少根目录manifest.json；请选择新版数据包，无需手动解压');
  const manifest = validateManifest(parseJson(raw!, 'manifest.json'), limits);
  if (files.size !== manifest.files.length + 1) packageError('包内文件与manifest清单不一致');
  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (
      !content ||
      content.length !== file.byteLength ||
      (await packageSha256(content)) !== file.sha256
    )
      packageError(`数据包文件缺失或SHA256校验失败：${file.path}`);
  }
  const payloads: DataPackagePayload[] = [];
  const descriptors = new Map(manifest.files.map((file) => [file.path, file]));
  const assetData = new Map<string, string>();
  const assetIdentities = new Map<string, string>();
  const ambiguousAssets = new Set<string>();
  for (const entry of manifest.payloads) {
    const data = parseJson(files.get(entry.path)!, entry.path);
    validateDataEnvelope(manifest.kind, data);
    if (Array.isArray(data.assets)) {
      data.assets = data.assets.map((asset: unknown) => {
        if (!asset || typeof asset !== 'object') return packageError('包内附件记录无效');
        const { packagePath, ...rest } = asset as Record<string, unknown>;
        if (
          typeof packagePath !== 'string' ||
          !packagePath.startsWith('assets/') ||
          Object.hasOwn(rest, 'dataBase64')
        )
          return packageError('附件必须通过包内路径引用，不能内嵌Base64');
        const bytes = files.get(packagePath),
          descriptor = descriptors.get(packagePath);
        if (
          !bytes ||
          !descriptor ||
          descriptor.mediaType !== rest.mimeType ||
          rest.sizeBytes !== bytes.length
        )
          return packageError('附件路径、类型或大小与清单不一致');
        if (typeof rest.id === 'string') {
          const key = `${descriptor.mediaType}:${descriptor.sha256}`;
          if (assetIdentities.has(rest.id) && assetIdentities.get(rest.id) !== key) {
            ambiguousAssets.add(rest.id);
            assetIdentities.delete(rest.id);
          }
          if (!ambiguousAssets.has(rest.id)) assetIdentities.set(rest.id, key);
        }
        let dataBase64 = assetData.get(packagePath);
        if (dataBase64 === undefined) {
          dataBase64 = bytesToBase64(bytes);
          assetData.set(packagePath, dataBase64);
        }
        return { ...rest, dataBase64 };
      });
    }
    payloads.push({ ...entry, data });
  }
  let questionHashes;
  const cache = files.get(QUESTION_HASHES_PATH);
  if (cache) {
    try {
      questionHashes = readPackageQuestionHashes(JSON.parse(decoder.decode(cache)), payloads, descriptors);
    } catch {
      // Optional metadata cannot make otherwise valid content unusable.
    }
  }
  return { manifest, payloads, files, ...(questionHashes?.size ? { questionHashes } : {}), questionHashAssets: assetIdentities };
}
