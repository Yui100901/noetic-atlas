import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
for (const name of ['server','shared','web']) {
  const target = resolve(root,'dist',name);
  if (relative(root,target).replaceAll('\\','/') !== `dist/${name}`) throw new Error('构建清理路径越界');
  await rm(target,{recursive:true,force:true});
}
