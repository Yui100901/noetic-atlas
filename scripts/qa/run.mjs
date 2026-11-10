/** Unified entry point; no build, device or real AI is started implicitly. */
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { catalog, groups, aliases, commandFor } from './catalog.mjs';
import {
  parseOptions,
  selectChecks,
  assertAllowed,
  runSuite,
  missingOptionalInputs,
} from './helpers/suite-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const help = `用法：node scripts/qa/run.mjs [--group smoke|browser|static|performance|live-ai|release|content-audit|android|local-source] [--only ID,ID] [--list|--dry-run]
默认运行smoke。--all仅运行离线浏览器、静态和性能组；串行运行，不自动构建。
真实AI须显式 --allow-live-ai；工作数据核对须显式 --allow-operator-data。
可重复--group和--only。报告与逐项日志在test-results/qa-runs/<时间-进程号>/。`;
try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    process.exitCode = 0;
  } else {
    const entries =
      options.list && !options.groups.length && !options.ids.length && !options.all
        ? catalog
        : selectChecks(catalog, groups, aliases, options);
    if (options.list || options.dryRun) {
      console.log(
        JSON.stringify(
          {
            groups,
            checks: entries.map((entry) => ({
              id: entry.id,
              groups: entry.groups,
              requirements: entry.requirements,
              access: entry.directArgs ? 'direct-command' : entry.access || 'isolated',
              command: [process.execPath, ...commandFor(entry)],
              timeoutMs: entry.timeoutMs,
              ...(entry.platform ? { platform: entry.platform } : {}),
              ...(entry.optionalInputs ? { optionalInputs: entry.optionalInputs } : {}),
            })),
            ...(options.dryRun ? { dryRun: true, executed: 0 } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      assertAllowed(entries, options);
      // Check local prerequisites before any partial execution. Browser packages
      // remain optional tooling and are never installed by this runner.
      for (const entry of entries) await access(resolve(root, entry.script));
      const runnable = [];
      for (const entry of entries)
        if (!(await missingOptionalInputs(entry, root))) runnable.push(entry);
      const requirements = new Set(runnable.flatMap((entry) => entry.requirements));
      for (const [requirement, file] of [
        ['web-build', 'dist/web/index.html'],
        ['mobile-build', 'dist/mobile/index.html'],
      ])
        if (requirements.has(requirement))
          await access(resolve(root, file)).catch(() => {
            throw Error(
              `${file}不存在；请先运行${requirement === 'web-build' ? 'npm run build' : 'npm run mobile:build'}`,
            );
          });
      if (requirements.has('browser')) {
        const { loadPlaywright } = await import('./helpers/browser-runtime.mjs');
        await loadPlaywright();
      }
      const directory = resolve(
        root,
        'test-results/qa-runs',
        new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid,
      );
      await mkdir(directory, { recursive: true });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      try {
        console.log(`运行 ${entries.length} 项；报告：${directory}`);
        const report = await runSuite(entries, {
          root,
          directory,
          signal: controller.signal,
          onProgress: (item) =>
            console.log(`${item.status}: ${item.id}${item.log ? ` (${item.log})` : ''}`),
        });
        console.log(
          JSON.stringify({
            ok: report.ok,
            summary: report.summary,
            notRun: report.notRun,
            report: resolve(directory, 'report.json'),
          }),
        );
        process.exitCode = report.cancelled ? 130 : report.ok ? 0 : 1;
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
