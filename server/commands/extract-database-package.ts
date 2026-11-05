import { readFile, stat, writeFile } from 'node:fs/promises';
import { readDataPackage, SQLITE_PACKAGE_LIMITS } from '../../shared/packages/data-package.js';

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error('用法：npm run data:unpack -- <数据库包.zip> <新的目标.sqlite>');
  process.exitCode = 1;
} else {
  try {
    const info = await stat(source);
    if (!info.isFile() || info.size > SQLITE_PACKAGE_LIMITS.maxBytes)
      throw new Error('请选择1 GiB以内的数据库包文件');
    const { manifest, files } = await readDataPackage(
      await readFile(source),
      SQLITE_PACKAGE_LIMITS,
    );
    if (manifest.kind !== 'sqlite-backup') throw new Error('此包不用于完整数据库恢复');
    const path = manifest.files.find((file) => file.mediaType === 'application/vnd.sqlite3')!.path;
    const database = files.get(path)!;
    if (
      database.length < 100 ||
      new TextDecoder().decode(database.subarray(0, 16)) !== 'SQLite format 3\0'
    )
      throw new Error('包内文件不是有效的SQLite数据库');
    await writeFile(destination, database, { flag: 'wx' });
    console.log('已校验清单和摘要，数据库已写入新文件。停止旧服务后将 DATABASE_PATH 指向此文件。');
  } catch (error) {
    console.error(
      error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? '目标文件已存在，请选择新文件名。'
        : (error as Error).message,
    );
    process.exitCode = 1;
  }
}
