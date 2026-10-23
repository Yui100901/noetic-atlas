'use strict';

// This module deliberately contains no Electron dependency: the portable server
// lifecycle and filesystem rules can be exercised against the shipped Node.
const { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync, writeFileSync, unlinkSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

class DesktopError extends Error {
  constructor(message, code = 'DESKTOP_START_FAILED') { super(message); this.name = 'DesktopError'; this.code = code; }
}
const inside = (parent, target) => { const path = relative(parent, target); return path === '' || !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path); };
const canonical = path => realpathSync.native(path);
function directory(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new DesktopError('桌面运行文件不完整，请重新完整解压 Windows 发布包。', 'MISSING_RUNTIME');
  return canonical(path);
}
function file(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new DesktopError('桌面运行文件不完整，请重新完整解压 Windows 发布包。', 'MISSING_RUNTIME');
  return canonical(path);
}

function preparePaths({ execPath = process.execPath, resourcesPath, env = process.env, portableRoot } = {}) {
  if (!resourcesPath) throw new DesktopError('未找到桌面运行资源。', 'MISSING_RUNTIME');
  const resources = directory(resolve(env.NOETIC_DESKTOP_RESOURCES || resourcesPath));
  const root = directory(resolve(portableRoot || dirname(execPath)));
  const serverRoot = directory(join(resources, 'server'));
  const nodePath = file(join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
  const serverEntry = file(join(serverRoot, 'desktop', 'server.mjs'));
  file(join(serverRoot, 'dist', 'server', 'index.js'));
  file(join(serverRoot, 'dist', 'web', 'index.html'));
  if (env.NOETIC_ATLAS_DATA_DIR && !isAbsolute(env.NOETIC_ATLAS_DATA_DIR)) throw new DesktopError('NOETIC_ATLAS_DATA_DIR 必须是绝对路径。', 'INVALID_DATA_DIRECTORY');
  let dataDirectory = resolve(env.NOETIC_ATLAS_DATA_DIR || join(root, 'data'));
  if (inside(resources, dataDirectory) || inside(dataDirectory, resources)) throw new DesktopError('数据目录须与程序资源目录分开，请使用解压目录内的 data 文件夹或另一独立目录。', 'INVALID_DATA_DIRECTORY');
  try {
    mkdirSync(dataDirectory, { recursive: true }); dataDirectory = canonical(dataDirectory);
    if (inside(resources, dataDirectory) || inside(dataDirectory, resources)) throw new DesktopError('数据目录不能指向程序资源目录。', 'INVALID_DATA_DIRECTORY');
    accessSync(dataDirectory, constants.R_OK | constants.W_OK);
    const probe = join(dataDirectory, `.noetic-write-${randomUUID()}`);
    writeFileSync(probe, '', { flag: 'wx' }); unlinkSync(probe);
    for (const folder of ['desktop', 'desktop/browser', 'desktop/logs', 'desktop/crashes']) mkdirSync(join(dataDirectory, folder), { recursive: true });
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('认知星图无法写入数据目录。请将完整解压目录移动到有写入权限的位置，或把 NOETIC_ATLAS_DATA_DIR 设置为可写目录的绝对路径。', 'DATA_DIRECTORY_NOT_WRITABLE');
  }
  return { resources, portableRoot: root, serverRoot, nodePath, serverEntry, dataDirectory, databasePath: join(dataDirectory, 'noetic-atlas.sqlite') };
}

function isLocalNavigation(url, origin) {
  try { const candidate = new URL(url); return candidate.origin === origin && candidate.protocol === 'http:' && !candidate.username && !candidate.password; } catch { return false; }
}
function isAllowedDownload(url, origin) {
  if (isLocalNavigation(url, origin)) return true;
  try { const candidate = new URL(url); return candidate.protocol === 'blob:' && new URL(candidate.pathname).origin === origin; } catch { return false; }
}

async function launchServer(paths, { timeoutMs = 45000, shutdownMs = 10000, onUnexpectedExit = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const childEnv = { ...process.env };
  // Electron and Node diagnostics must not alter the bundled standalone server.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_INSPECT_RESUME_ON_START']) delete childEnv[key];
  const child = spawn(paths.nodePath, [paths.serverEntry], { cwd: paths.serverRoot, env: childEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let stopping = false, closed = false, stopPromise;
  const exited = new Promise(resolveExit => {
    child.once('exit', (code, signal) => { if (closed) return; closed = true; resolveExit({ code, signal }); if (!stopping) onUnexpectedExit({ code, signal }); });
    child.once('error', () => { if (closed) return; closed = true; resolveExit({ code: null, signal: null }); });
  });
  async function close() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      if (closed || child.exitCode !== null) return;
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      let timer;
      await Promise.race([exited, new Promise(resolveTimer => { timer = setTimeout(resolveTimer, shutdownMs); })]); clearTimeout(timer);
      if (!closed) { child.kill(); let killTimer; await Promise.race([exited, new Promise(resolveTimer => { killTimer = setTimeout(resolveTimer, 3000); })]); clearTimeout(killTimer); }
    })();
    return stopPromise;
  }
  try {
    const origin = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => finish(new DesktopError('本地学习服务启动超时，请检查数据目录是否被其他程序占用。', 'SERVER_TIMEOUT')), timeoutMs);
      function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('error', errorHandler); child.off('exit', earlyExit); if (error) rejectReady(error); else resolveReady(value); }
      function errorHandler() { finish(new DesktopError('无法启动随附的 Node 运行环境，请检查发布包是否解压完整。', 'SERVER_START_FAILED')); }
      function earlyExit() { finish(new DesktopError('本地学习服务未能启动。请确认数据目录可写、数据库文件正常，并重新启动。', 'SERVER_START_FAILED')); }
      function message(value) {
        if (value?.type === 'ready') {
          if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return finish(new DesktopError('本地学习服务返回了无效地址。', 'INVALID_SERVER_ADDRESS'));
          finish(null, `http://127.0.0.1:${value.port}`);
        } else if (value?.type === 'startup-error') finish(new DesktopError('本地学习服务启动失败。请确认数据库文件未损坏且数据目录可写。', 'SERVER_START_FAILED'));
      }
      child.on('message', message); child.once('error', errorHandler); child.once('exit', earlyExit);
      child.send({ type: 'start', dataDirectory: paths.dataDirectory }, error => { if (error) errorHandler(); });
    });
    const response = await fetchImpl(`${origin}/api/health`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)) });
    if (!response.ok || (await response.json()).ok !== true) throw new DesktopError('本地学习服务健康检查未通过。', 'SERVER_HEALTH_FAILED');
    return { child, origin, close, exited };
  } catch (error) { await close(); throw error instanceof DesktopError ? error : new DesktopError('本地学习服务连接失败，请重新启动认知星图。', 'SERVER_HEALTH_FAILED'); }
}

module.exports = { DesktopError, preparePaths, isLocalNavigation, isAllowedDownload, launchServer };
