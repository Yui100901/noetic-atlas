import type { Store } from '../../core/store.js';
import { recordTables } from '../../database/schema.js';
import { assetReferenceSources } from '../../database/asset-reference-sources.js';
import type { DataHealth } from '../../../shared/models/maintenance.js';
import { maintenanceJournal } from './journal.js';

export function dataHealth(store: Store, integrity = false): DataHealth {
  const db = store.database,
    x = db.expressions;
  db.projections.ensure(assetReferenceSources);
  const counts = Object.fromEntries(
    recordTables.map((table) => [
      table,
      Number(
        db.one(db.query.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('count')))
          ?.count || 0,
      ),
    ]),
  );
  const unused = db.one(
    db.query
      .selectFrom('assets as a')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_references as r')
              .select('r.asset_id')
              .whereRef('r.asset_id', '=', 'a.id'),
          ),
        ),
      )
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        eb.fn.sum<number>(x.field<number>('a.data', 'sizeBytes')).as('bytes'),
      ]),
  );
  const missing = Number(
    db.one(
      db.query
        .selectFrom('asset_references as r')
        .leftJoin('assets as a', 'a.id', 'r.asset_id')
        .where('a.id', 'is', null)
        .select((eb) => eb.fn.countAll<number>().as('count')),
    )?.count || 0,
  );
  const activeAiJobs = Number(
    db.one(
      db.query
        .selectFrom('ai_import_jobs')
        .where(x.field('data', 'status'), 'in', ['pending', 'running'])
        .select((eb) => eb.fn.countAll<number>().as('count')),
    )?.count || 0,
  );
  const storage = db.storageHealth(integrity),
    issues: DataHealth['issues'] = [];
  if (storage.integrity?.some((value) => value !== 'ok'))
    issues.push({
      level: 'warning',
      message: '数据库一致性检查发现异常，请先导出可读取的备份并检查恢复副本。',
    });
  if (missing)
    issues.push({
      level: 'warning',
      message: `存在${missing}处无法找到的附件引用，请核对原资料与备份。`,
      href: '#/settings?tab=assets',
    });
  if (Number(unused?.count))
    issues.push({ level: 'info', message: `有${unused!.count}份未引用文件，可预览后清理。` });
  if (storage.freeBytes > 1024 * 1024)
    issues.push({ level: 'info', message: '数据库有可复用空闲页，清理完成后可整理空间。' });
  if (activeAiJobs)
    issues.push({
      level: 'info',
      message: `有${activeAiJobs}个教材任务尚未完成，清理会保留这些任务及关联记录。`,
      href: '#/sharing?tab=import&process=batch',
    });
  return {
    checkedAt: new Date().toISOString(),
    storage,
    counts,
    unusedAssets: Number(unused?.count || 0),
    unusedAssetBytes: Number(unused?.bytes || 0),
    activeAiJobs,
    issues,
    operations: maintenanceJournal(store),
  };
}
