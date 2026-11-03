import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildState, projectRoot } from './build/start-cache.mjs';

export function startupMode(args) {
  if (args.some((v) => !['--fast', '--build', '--plan', '--help'].includes(v)))
    throw new Error('参数支持 --fast、--build、--plan、--help');
  if (args.includes('--fast') && args.includes('--build'))
    throw new Error('--fast 与 --build 不能同时使用');
  return args.includes('--build') ? 'build' : args.includes('--fast') ? 'fast' : 'auto';
}
const args = process.argv.slice(2),
  started = performance.now();
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 13)
    throw new Error('需要Node.js 24.13或更新的24.x版本；请安装后重试，或通过NOETIC_NODE指定路径。');
  const mode = startupMode(args);
  if (args.includes('--help')) {
    console.log(
      '启动学习站 [--fast | --build] [--plan]\n默认自动检测：未变化直接启动，变化后构建。--fast 使用上次成功构建；--build 强制重建；--plan 只检查不启动。',
    );
    process.exit(0);
  }
  const host = process.env.HOST || '127.0.0.1',
    port = process.env.PORT || '4317';
  if (!args.includes('--plan')) {
    const address = `http://${host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host}:${port}`;
    let running = false,
      occupied = false;
    try {
      const health = await fetch(address + '/api/health', { signal: AbortSignal.timeout(1000) });
      occupied = true;
      if (health.ok) {
        const data = await health.json();
        running = data.ok === true && data.application === 'noetic-atlas';
      }
      if (!running) {
        const response = await fetch(address + '/api/openapi.json', {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const doc = await response.json();
          running = String(doc.info?.title || '').includes('Noetic Atlas API');
        }
      }
    } catch (error) {
      if (error.name === 'TimeoutError') occupied = true;
    }
    if (occupied && !running)
      throw new Error(
        `地址 ${address} 已有服务响应，但未能确认为学习站。请确认现有窗口或更改PORT，本次不启动第二个进程。`,
      );
    if (running) {
      if (mode === 'build')
        throw new Error(`学习站已在 ${address} 运行，请先关闭原服务窗口再重新构建启动。`);
      console.log(
        `[启动] 已有学习站运行：${address}。本次复用现有服务；刚更新代码时请关闭原窗口后重新启动。`,
      );
      process.exit(0);
    }
  }
  const state = buildState(projectRoot, { sources: mode !== 'fast' });
  const needsBuild = mode === 'build' || (mode === 'auto' && !state.fresh);
  if (args.includes('--plan')) {
    console.log(
      JSON.stringify({
        mode,
        needsBuild,
        ...state,
        checkMs: Math.round(performance.now() - started),
      }),
    );
    process.exit(0);
  }
  if (mode === 'fast' && !state.ready)
    throw new Error(`${state.reason}；请先运行 npm run build 或启动学习站.cmd --build。`);
  const run = (file, arguments_) =>
    new Promise((done, reject) => {
      const child = spawn(process.execPath, [file, ...arguments_], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
      });
      const stop = () => child.kill('SIGTERM');
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        done(code ?? (signal ? 130 : 1));
      });
    });
  const npm = [
    process.env.NOETIC_NPM_CLI,
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((p) => p && existsSync(p));
  const dependenciesMissing = [
    'node_modules/fastify/package.json',
    'node_modules/pdfjs-dist/build/pdf.mjs',
  ].some((p) => !existsSync(resolve(projectRoot, p)));
  if (dependenciesMissing) {
    if (!npm) throw new Error('缺少运行依赖且未找到npm，请先执行npm ci。');
    console.log('[启动] 首次安装运行依赖…');
    const code = await run(npm, ['ci']);
    if (code) process.exit(code);
  }
  if (needsBuild) {
    console.log(
      `[启动] ${mode === 'build' ? '按要求强制构建' : state.reason}，正在构建；后续源码未变化时将直接启动。`,
    );

    if (!npm) throw new Error('未找到npm CLI。请先运行 npm run build，再用 --fast 启动。');
    const code = await run(npm, ['run', 'build']);
    if (code) process.exit(code);
  } else
    console.log(
      `[启动] ${mode === 'fast' ? '使用上次成功构建，跳过源码更新检查的构建步骤' : state.reason}。`,
    );
  console.log(
    `[启动] 构建准备 ${Math.round(performance.now() - started)} ms；地址 http://${host}:${port}，按 Ctrl+C 退出。`,
  );
  process.exitCode = await run('dist/server/main.js', []);
} catch (error) {
  console.error('[启动失败] ' + error.message);
  process.exitCode = 1;
}
