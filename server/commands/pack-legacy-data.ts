import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  buildDataPackage,
  DATA_PACKAGE_LIMITS,
  dataPackageKinds,
  SQLITE_PACKAGE_LIMITS,
  type DataPackageKind,
} from '../../shared/packages/data-package.js';

const [purpose, destination, ...sources] = process.argv.slice(2);
if (
  !destination?.toLowerCase().endsWith('.zip') ||
  !sources.length ||
  !dataPackageKinds.includes(purpose as DataPackageKind)
) {
  console.error(
    `用法：npm run data:pack -- <${dataPackageKinds.join('|')}> <新的数据包.zip> <旧文件> [其他JSON分片...]`,
  );
  process.exitCode = 1;
} else {
  try {
    const kind = purpose as DataPackageKind;
    const title = `认知星图 ${kind} 数据包`;
    const sqlite = kind === 'sqlite-backup';
    const limits = sqlite ? SQLITE_PACKAGE_LIMITS : DATA_PACKAGE_LIMITS;
    if (sqlite && sources.length !== 1) throw new Error('数据库包只接受一个SQLite源文件');
    if (sources.length > limits.maxPayloads) throw new Error('数据分片数量超过限制');
    const sizes = await Promise.all(sources.map((path) => stat(path)));
    if (
      sizes.some((file) => !file.isFile() || file.size > limits.maxFileBytes) ||
      sizes.reduce((sum, file) => sum + file.size, 0) > limits.maxExpandedBytes
    )
      throw new Error('源文件超过允许大小，请分包或使用完整数据库备份');
    const payloads = [];
    const files = [];
    for (const [index, source] of sources.entries()) {
      const bytes = await readFile(source);
      if (sqlite) {
        if (bytes.length < 100 || bytes.toString('utf8', 0, 16) !== 'SQLite format 3\0')
          throw new Error('源文件不是SQLite数据库');
        files.push({ path: 'database/backup.sqlite', bytes, mediaType: 'application/vnd.sqlite3' });
      } else {
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        payloads.push({ path: `data/part-${String(index + 1).padStart(3, '0')}.json`, data });
      }
    }
    const packet = await buildDataPackage({ kind, title, payloads, files, limits });
    await writeFile(destination, packet, { flag: 'wx' });
    console.log(`数据包已生成：${destination}`);
  } catch (error) {
    console.error(
      error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? '目标文件已存在，请选择新文件名。'
        : (error as Error).message,
    );
    process.exitCode = 1;
  }
}
