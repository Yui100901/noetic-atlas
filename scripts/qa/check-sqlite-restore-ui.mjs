/** Isolated Android restore UI regression check. No installed app/data is used.
 * Run: node scripts/qa/check-sqlite-restore-ui.mjs
 * Optional PLAYWRIGHT_MODULE: module specifier or absolute Playwright index.mjs.
 * Optional PLAYWRIGHT_CHROMIUM_EXECUTABLE: installed Chromium executable.
 * Screenshots and generated mock fixtures stay under test-results/.
 */
import { build } from 'vite';
import { createServer } from 'node:http';
import react from '@vitejs/plugin-react';
import { writeFile, readFile, readdir, mkdir, access } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const folder = resolve(root, 'test-results/native-restore-ui');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    const module = process.env.PLAYWRIGHT_MODULE;
    return import(isAbsolute(module) ? pathToFileURL(module).href : module);
  }
  try { return await import('playwright'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  // Codex's bundled dependency runtime is optional; plain project installations
  // can provide Playwright normally or point PLAYWRIGHT_MODULE at their runtime.
  const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  if (await exists(bundled)) return import(pathToFileURL(bundled).href);
  throw new Error('Playwright was not found. Install it in the project or set PLAYWRIGHT_MODULE to its index.mjs.');
}
async function browserExecutable(chromium) {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit) { assert.ok(await exists(explicit), 'PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist'); return { executablePath: explicit }; }
  if (await exists(chromium.executablePath())) return {};
  // A shared runtime may ship a compatible installed browser at a different
  // Playwright revision. Use only an existing local executable; never download.
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'), join(homedir(), '.cache/ms-playwright')].filter(path => path && path !== '0');
  for (const cache of caches) {
    if (!await exists(cache)) continue;
    const revisions = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const revision of revisions) for (const binary of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell']) {
      const executablePath = join(cache, revision, binary);
      if (await exists(executablePath)) return { executablePath };
    }
  }
  return {};
}
const { chromium } = await loadPlaywright();
await mkdir(folder, { recursive: true });
await writeFile(resolve(folder,'platform.ts'), `
const backup={id:'qa-original',createdAt:'2026-10-24T04:00:00.000Z',byteLength:524288};
export const isNativeApp=()=>true;
export async function nativeLatestRecoveryBackup(){return JSON.parse(localStorage.getItem('qa-backup')||'null')||undefined;}
export async function nativeDownloadRecoveryBackup(id){localStorage.setItem('qa-exported',id);}
export async function nativePreviewSQLiteRestore(file){
 await new Promise(resolve=>setTimeout(resolve,60));
 if(file.name.startsWith('invalid'))throw new Error('SQLite 备份校验失败：不是 SQLite 3 数据库文件');
 const bytes=new Uint8Array(await file.arrayBuffer());if(!bytes.length)throw new Error('empty');
 const counts={questions:25,papers:4,documents:3,assets:6,attempts:1,learning_results:7,study:4,study_parts:3,reviews:2,domains:2,categories:5,tags:4,paper_drafts:1,settings:1,ai_settings:1,ai_runs:9};
 return {token:file.name,filename:file.name,byteLength:bytes.length,sha256:'1234567890abcdef'.repeat(4),schemaVersion:1,counts,currentCounts:{questions:8,papers:2,attempts:3},sourceHadAiKey:true,activeExamCount:0};
}
export async function nativeConfirmSQLiteRestore(token){localStorage.setItem('qa-backup',JSON.stringify(backup));if(token.startsWith('fail'))throw new Error('恢复失败，原数据已保留，应用可继续使用。');localStorage.setItem('qa-restored','yes');return {recoveryBackup:backup};}
export async function nativeFetch(){throw new Error('not used in UI mock');}
export async function nativeDownload(){}
export async function saveGeneratedFile(){}
`);
await writeFile(resolve(folder,'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {SQLiteRestore} from '../../web/features/settings/sqlite-restore';import '../../web/app/styles.css';createRoot(document.getElementById('root')!).render(<main style={{maxWidth:900,margin:'32px auto',padding:16}}><SQLiteRestore /></main>);`);
const built=resolve(folder,'built');
await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('production')},plugins:[react()],resolve:{alias:[{find:'@platform',replacement:resolve(folder,'platform.ts')}]},publicDir:false,build:{outDir:built,emptyOutDir:true,lib:{entry:resolve(folder,'entry.tsx'),formats:['es'],fileName:()=> 'ui.mjs'}}});
const css=(await readdir(built)).find(file=>file.endsWith('.css'));
const server=createServer(async(req,res)=>{if(req.url==='/ui.mjs'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(resolve(built,'ui.mjs')));}else if(req.url==='/ui.css'){res.setHeader('Content-Type','text/css');res.end(css?await readFile(resolve(built,css)):'');}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="/ui.css"/><title>恢复界面隔离验证</title></head><body><div id="root"></div><script type="module" src="/ui.mjs"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
let browser;
try {
 browser=await chromium.launch({headless:true,...await browserExecutable(chromium)});
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try {
 await page.goto('http://127.0.0.1:'+port+'/restore-qa');await page.getByRole('heading',{name:'从 SQLite 备份完整恢复'}).waitFor();
 const file=page.getByLabel('选择 SQLite 数据库备份');const choose=page.getByRole('button',{name:'选择 SQLite 数据库备份',exact:true});
 await file.setInputFiles({name:'invalid.sqlite',mimeType:'application/vnd.sqlite3',buffer:Buffer.from('invalid')});await page.getByRole('alert').filter({hasText:'不是 SQLite'}).waitFor();assert.equal(await choose.isEnabled(),true);
 await file.setInputFiles({name:'fail.sqlite',mimeType:'application/vnd.sqlite3',buffer:Buffer.from('SQLite format 3 mock')});await page.getByRole('heading',{name:'已通过校验：fail.sqlite'}).waitFor();
 const restore=page.getByRole('button',{name:'保留当前副本并完整恢复',exact:true});assert.equal(await restore.isDisabled(),true);assert.equal(await page.locator('tbody tr').count(),16);
 await page.getByRole('checkbox').check();assert.equal(await restore.isEnabled(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile preview has no horizontal page overflow');
 await page.screenshot({path:resolve(folder,'preview-mobile.png'),fullPage:true});
 await restore.click();await page.getByRole('alert').filter({hasText:'原数据已保留'}).waitFor();assert.equal(await choose.isEnabled(),true);assert.equal(await page.getByRole('heading',{name:'已通过校验：fail.sqlite'}).count(),0);
 await page.screenshot({path:resolve(folder,'rollback-mobile.png'),fullPage:true});await page.getByRole('button',{name:'保存或分享恢复前副本'}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('qa-exported')),'qa-original');assert.equal(await page.evaluate(()=>localStorage.getItem('qa-restored')),null);
 await page.setViewportSize({width:1280,height:900});await file.setInputFiles({name:'success.sqlite',mimeType:'application/vnd.sqlite3',buffer:Buffer.from('SQLite format 3 mock')});await page.getByRole('heading',{name:'已通过校验：success.sqlite'}).waitFor();await page.getByRole('checkbox').check();await page.screenshot({path:resolve(folder,'preview-desktop.png'),fullPage:true});
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'保留当前副本并完整恢复',exact:true}).click()]);
 await page.getByRole('button',{name:'保存或分享恢复前副本'}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('qa-restored')),'yes');assert.equal(await page.getByRole('checkbox').count(),0);assert.deepEqual(errors,[]);
 console.log('UI QA passed: invalid file; preview/counts/explicit confirmation; mobile layout; failed restore keeps page usable and exports recovery; successful restore reloads and retains recovery access; no browser exceptions.');
 } catch(error) { console.error('Browser errors:',errors); console.error('Page snapshot:',await page.locator('body').innerHTML()); throw error; }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }

