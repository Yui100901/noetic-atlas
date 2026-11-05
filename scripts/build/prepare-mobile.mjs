import { resolve } from 'node:path';
import { createGeneratedAssetPlan, applyGeneratedAssetPlan } from './generated-assets.mjs';
import { preflightGeneratedDirectory, resetGeneratedDirectory } from './generated-paths.mjs';

const root = resolve(import.meta.dirname, '../..');
// Validate all sources and destinations before clearing the previous build.
const plan = await createGeneratedAssetPlan(root, 'mobile');
await preflightGeneratedDirectory(root, 'dist/mobile');
await applyGeneratedAssetPlan(plan);
await resetGeneratedDirectory(root, 'dist/mobile');
console.log('已准备空安装基础配置与完整离线资源，并清除移动端旧构建；不内置题库。');
