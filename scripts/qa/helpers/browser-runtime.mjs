/** Optional browser tooling, resolved in one place for local QA and CI. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function browserConfiguration(env = process.env, platform = process.platform) {
  const channel = env.PLAYWRIGHT_CHANNEL || (platform === 'win32' ? 'msedge' : 'chromium');
  return {
    module: env.PLAYWRIGHT_MODULE
      ? pathToFileURL(resolve(env.PLAYWRIGHT_MODULE)).href
      : 'playwright',
    launch: { headless: true, ...(channel === 'chromium' ? {} : { channel }) },
  };
}
export async function loadPlaywright(env = process.env) {
  try {
    return await import(browserConfiguration(env).module);
  } catch (error) {
    throw new Error(
      '浏览器验收需要Playwright；请安装可选QA工具，或设置PLAYWRIGHT_MODULE为其入口文件。',
      { cause: error },
    );
  }
}
export async function createQaBrowser() {
  const { chromium } = await loadPlaywright();
  return chromium.launch(browserConfiguration().launch);
}
export function fixtureReadyTimeout(env = process.env) {
  const value = Number(env.QA_FIXTURE_READY_TIMEOUT_MS || 120_000);
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000)
    throw Error('QA_FIXTURE_READY_TIMEOUT_MS必须为1000至300000毫秒');
  return value;
}
export async function waitForQaReady(
  child,
  { prefix, stdout, stderr, timeoutMs = fixtureReadyTimeout() },
) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const line = stdout()
      .split(/\r?\n/)
      .find((value) => value.startsWith(prefix));
    if (line) return JSON.parse(line.slice(prefix.length));
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error(`QA fixture exited before readiness: ${stderr()}`);
    await delay(50);
  }
  throw Error(`QA fixture readiness timed out after ${timeoutMs}ms: ${stderr()}`);
}
