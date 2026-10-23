'use strict';
const { app, BrowserWindow, dialog, Menu } = require('electron');
const { join } = require('node:path');
const { preparePaths, launchServer, isLocalNavigation, isAllowedDownload } = require('./runtime.cjs');

app.setName('认知星图');
let window, service, quitting = false, failureShown = false;
function showFailure(message) {
  if (quitting || failureShown) return; failureShown = true;
  dialog.showErrorBox('认知星图', message);
  if (window && !window.isDestroyed()) window.destroy();
  app.quit();
}
let paths;
try {
  paths = preparePaths({ resourcesPath: process.resourcesPath });
  app.setPath('userData', join(paths.dataDirectory, 'desktop'));
  app.setPath('sessionData', join(paths.dataDirectory, 'desktop', 'browser'));
  app.setPath('crashDumps', join(paths.dataDirectory, 'desktop', 'crashes'));
  app.setAppLogsPath(join(paths.dataDirectory, 'desktop', 'logs'));
} catch (error) {
  app.whenReady().then(() => showFailure(error.message || '无法初始化桌面数据目录。'));
}
if (paths) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    app.whenReady().then(async () => {
      try {
        Menu.setApplicationMenu(null);
        service = await launchServer(paths, { onUnexpectedExit: () => { if (service) showFailure('本地学习服务意外退出。请重新启动认知星图；已保存的学习数据仍在 data 目录中。'); } });
        if (quitting) { await service.close(); return; }
        window = new BrowserWindow({
          title: '认知星图', width: 1360, height: 900, minWidth: 840, minHeight: 600,
          show: false, autoHideMenuBar: true, backgroundColor: '#f5f7fb',
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, spellcheck: false },
        });
        const contents = window.webContents;
        const appNavigation = url => isLocalNavigation(url, service.origin) && new URL(url).pathname === '/';
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', (event, url) => { if (!appNavigation(event.url || url)) event.preventDefault(); });
        contents.on('will-redirect', (event, url) => { if (!appNavigation(event.url || url)) event.preventDefault(); });
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.on('render-process-gone', () => showFailure('页面运行异常，请重新启动认知星图。已保存的数据仍在 data 目录中。'));
        contents.on('will-prevent-unload', event => {
          const answer = dialog.showMessageBoxSync(window, { type: 'question', title: '退出认知星图', message: '当前页面有未完成的作答或编辑，确定退出？', detail: '考试倒计时不会暂停；再次打开时将按原截止时间继续或自动交卷。已保存的草稿和数据会保留。', buttons: ['继续使用', '退出'], defaultId: 0, cancelId: 0, noLink: true });
          if (answer === 1) event.preventDefault();
        });
        contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        contents.session.setPermissionCheckHandler(() => false);
        contents.session.on('will-download', (event, item, source) => {
          if (source?.id !== contents.id || !isAllowedDownload(item.getURL(), service.origin)) { event.preventDefault(); return; }
          // With no setSavePath, Electron presents its native save dialog. Blob
          // URLs remain valid for browser-generated JSON/Markdown/PDF exports.
          const filename = item.getFilename().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || '认知星图导出';
          item.setSaveDialogOptions({ title: '保存认知星图导出文件', defaultPath: join(app.getPath('downloads'), filename) });
        });
        contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
          if (isMainFrame && code !== -3 && isLocalNavigation(url, service.origin)) showFailure('学习页面加载失败，请重新启动认知星图。');
        });
        window.once('ready-to-show', () => { window.show(); window.focus(); });
        window.on('closed', () => { window = undefined; });
        await window.loadURL(service.origin);
      } catch (error) { showFailure(error.message || '桌面端启动失败，请检查发布包是否解压完整。'); }
    });
  }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  // Ask the page's existing unsaved-work/exam guard before stopping its server.
  // A cancelled window close must leave the application fully usable.
  if (window && !window.isDestroyed()) { window.close(); return; }
  quitting = true;
  if (service) void service.close().finally(() => app.quit());
  else app.quit();
});
