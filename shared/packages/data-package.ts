import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64 } from '../assets/assets.js';
import { createStoredZip } from '../exports/zip.js';
import { readPackageArchive } from './archive-reader.js';
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
  for (const file of input.files || [])
    add(file.path, file.bytes, file.mediaType || 'application/octet-stream');
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
    payloads.push({ path: part.path, ...(part.domainIds ? { domainIds: part.domainIds } : {}) });
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
    return createStoredZip(
      [
        { name: 'manifest.json', bytes: manifestBytes },
        ...Array.from(files, ([name, file]) => ({ name, bytes: file.bytes })),
      ],
      limits.maxBytes,
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
  return { manifest, payloads, files };
}
