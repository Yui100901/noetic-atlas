import { resolve } from 'node:path';
import { prepareGeneratedAssets } from './generated-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const report = await prepareGeneratedAssets(root, { target: 'web' });
console.log(
  `Web 离线资源：${report.filter((item) => item.status === 'updated').length} 个目录已更新，其余未改动。`,
);
