import { mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { validateEmptyInstall, validateBaseConfiguration } from '../release/validate-public-data.mjs';
const root = resolve(import.meta.dirname, '../..');
validateEmptyInstall();
validateBaseConfiguration(JSON.parse(await readFile(resolve(root,'config/defaults.json'),'utf8')));
// This dedicated generated output must never retain previous hash-named JS or
// font files. Keep cleanup inside dist/mobile; dist/server and APKs stay intact.
const mobileOutput = resolve(root, 'dist/mobile');
if (relative(root, mobileOutput) !== join('dist', 'mobile')) throw new Error('移动端构建输出路径无效');
await rm(mobileOutput, { recursive: true, force: true });
const nativeAssets=resolve(root, 'mobile/assets');
if(relative(root,nativeAssets)!==join('mobile','assets'))throw new Error('移动端生成资源目录无效');
await rm(nativeAssets,{recursive:true,force:true});
await mkdir(nativeAssets,{recursive:true});
await mkdir(resolve(root, 'mobile/assets/config'), { recursive: true });
await copyFile(resolve(root, 'config/defaults.json'), resolve(root, 'mobile/assets/config/defaults.json'));
await copyFile(resolve(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), resolve(root, 'mobile/assets/sql-wasm.wasm'));
await mkdir(resolve(root, 'mobile/assets/licenses'), { recursive: true });
await copyFile(resolve(root, 'web/assets/fonts/OFL-NotoSansCJK.txt'), resolve(root, 'mobile/assets/licenses/NotoSansCJK-OFL.txt'));
console.log('已准备空安装基础配置与离线 SQLite WASM；不内置题库。');
