/** Device ownership is limited to the fixed, separately built .qa application. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const QA_PACKAGE = 'cn.noetic.atlas.qa';
export async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(150);
  }
  throw Error('Timed out: ' + label);
}
export async function connectAndroid({ serial = process.env.ANDROID_SERIAL, entry, ime } = {}) {
  assert.ok(serial, 'Specify --serial or ANDROID_SERIAL; never select an arbitrary device');
  if (entry)
    assert.match(
      entry,
      /^assets\/qa-[A-Za-z0-9_-]+\.js$/,
      'Only local QA entry resources may be loaded',
    );
  const root = resolve(import.meta.dirname, '../../..'),
    folder = join(root, 'test-results/android-layout');
  await mkdir(folder, { recursive: true });
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const adbPath =
    process.env.ANDROID_ADB ||
    join(
      process.env.ANDROID_HOME || join(root, '.localtools/android-sdk'),
      'platform-tools',
      executable,
    );
  const adb = (...args) =>
    execFileSync(adbPath, ['-s', serial, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  assert.ok(
    adb('shell', 'pm', 'path', QA_PACKAGE).startsWith('package:'),
    'Install the separate QA APK first',
  );
  const original = {
    size: adb('shell', 'wm', 'size'),
    density: adb('shell', 'wm', 'density'),
    rotation: adb('shell', 'wm', 'user-rotation'),
    fixedRotation: adb('shell', 'wm', 'fixed-to-user-rotation'),
    fontScale: adb('shell', 'settings', 'get', 'system', 'font_scale'),
    ime: adb('shell', 'settings', 'get', 'secure', 'default_input_method'),
    enabledIme: adb('shell', 'settings', 'get', 'secure', 'enabled_input_methods'),
    hardwareIme: adb('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard'),
  };
  // Persist before the first mutation, so interrupted runs remain recoverable.
  await writeFile(
    join(folder, 'device-before.json'),
    JSON.stringify({ serial, original }, null, 2),
  );
  const forwards = [];
  let browser,
    page,
    entryPath = entry,
    closed = false;
  const errors = [],
    network = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const cleanupErrors = [];
    const clean = (...args) => {
      try {
        adb(...args);
      } catch (error) {
        cleanupErrors.push(String(error.message).slice(0, 300));
      }
    };
    await browser?.close().catch(() => {});
    clean('shell', 'am', 'force-stop', QA_PACKAGE);
    try {
      assert.equal(adb('shell', 'pm', 'clear', QA_PACKAGE), 'Success');
    } catch (error) {
      cleanupErrors.push('QA data clear failed: ' + error.message);
    }
    // QA profiles change orientation and font size only. In particular, do not
    // write wm size/density even to restore the same value: these are the
    // operator's display settings, not test-owned resources.
    if (
      ['default', 'disabled', 'enabled'].includes(original.fixedRotation) &&
      adb('shell', 'wm', 'fixed-to-user-rotation') !== original.fixedRotation
    )
      clean('shell', 'wm', 'fixed-to-user-rotation', original.fixedRotation);
    if (original.rotation.startsWith('lock'))
      clean('shell', 'wm', 'user-rotation', 'lock', original.rotation.match(/\d+/)?.[0] || '0');
    else clean('shell', 'wm', 'user-rotation', 'free');
    for (const [namespace, key, value] of [
      ['system', 'font_scale', original.fontScale],
      ['secure', 'default_input_method', original.ime],
      ['secure', 'enabled_input_methods', original.enabledIme],
      ['secure', 'show_ime_with_hard_keyboard', original.hardwareIme],
    ]) {
      if (value === 'null') clean('shell', 'settings', 'delete', namespace, key);
      else clean('shell', 'settings', 'put', namespace, key, value);
    }
    for (const port of forwards) clean('forward', '--remove', 'tcp:' + port);
    const state = {
      size: adb('shell', 'wm', 'size'),
      density: adb('shell', 'wm', 'density'),
      rotation: adb('shell', 'wm', 'user-rotation'),
      fixedRotation: adb('shell', 'wm', 'fixed-to-user-rotation'),
      fontScale: adb('shell', 'settings', 'get', 'system', 'font_scale'),
      ime: adb('shell', 'settings', 'get', 'secure', 'default_input_method'),
      enabledIme: adb('shell', 'settings', 'get', 'secure', 'enabled_input_methods'),
      hardwareIme: adb('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard'),
    };
    const report = { original, restored: state, cleanupErrors };
    await writeFile(join(folder, 'device-cleanup.json'), JSON.stringify(report, null, 2));
    // Android may persist its default 1.0 after deleting an originally absent
    // font_scale setting. Compare the effective setting, preserving raw evidence.
    const effective = (value) => ({
      ...value,
      fontScale: value.fontScale === 'null' ? 1 : Number(value.fontScale),
    });
    assert.deepEqual(
      effective(state),
      effective(original),
      'Device settings were not fully restored',
    );
    assert.deepEqual(cleanupErrors, []);
  };
  try {
    assert.equal(adb('shell', 'pm', 'clear', QA_PACKAGE), 'Success');
    if (ime) {
      assert.match(ime, /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/);
      adb(
        'shell',
        'settings',
        'put',
        'secure',
        'enabled_input_methods',
        original.enabledIme + ':' + ime,
      );
      adb('shell', 'settings', 'put', 'secure', 'default_input_method', ime);
      adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
    }
    const connect = async () => {
      adb('shell', 'am', 'start', '-W', '-n', QA_PACKAGE + '/cn.noetic.atlas.MainActivity');
      await until(async () => {
        try {
          return !!adb('shell', 'pidof', QA_PACKAGE);
        } catch {
          return false;
        }
      }, 'QA app process');
      const pid = adb('shell', 'pidof', QA_PACKAGE),
        port = adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid);
      forwards.push(port);
      await until(async () => {
        try {
          const r = await fetch('http://127.0.0.1:' + port + '/json', {
            signal: AbortSignal.timeout(1500),
          });
          return (
            r.ok &&
            (await r.json()).some(
              (target) => target.type === 'page' && target.url.startsWith('https://localhost'),
            )
          );
        } catch {
          return false;
        }
      }, 'QA WebView debugging');
      const { chromium } = await import(
        process.env.PLAYWRIGHT_MODULE
          ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
          : 'playwright'
      );
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
      page = browser.contexts()[0].pages()[0];
      page.setDefaultTimeout(30000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && message.text().startsWith('[local-api]'))
          errors.push(message.text().slice(0, 500));
      });
      page.on('dialog', (dialog) => void dialog.accept());
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (
          !['https://localhost', 'https://localhost/'].includes(url.origin) &&
          !['blob:', 'data:'].includes(url.protocol)
        )
          network.push(url.origin);
      });
    };
    const attach = async () => {
      await page.locator('main').waitFor();
      if (!entryPath) {
        const metadata = await page.evaluate(async () => {
          const r = await fetch('/qa-entry.json');
          if (!r.ok) throw Error('This APK has no QA entry metadata');
          return r.json();
        });
        assert.equal(metadata.package, QA_PACKAGE);
        assert.match(metadata.entry, /^assets\/qa-[A-Za-z0-9_-]+\.js$/);
        entryPath = metadata.entry;
      }
      await page.evaluate(async (path) => {
        window.__noeticQA = await import('/' + path);
      }, entryPath);
    };
    await connect();
    await attach();
    assert.equal(await page.evaluate(() => window.Capacitor.getPlatform()), 'android');
    const api = (url, method = 'GET', body) =>
      page.evaluate(
        async ({ url, method, body }) => {
          const response = await window.__noeticQA.nativeFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const value = await response.json();
          if (!response.ok)
            throw Error('QA API ' + url + ': ' + response.status + ' ' + JSON.stringify(value));
          return value;
        },
        { url, method, body },
      );
    const go = async (path, { reload = true } = {}) => {
      if (reload) {
        // Refresh bootstrap after API-created fixtures.
        await page.goto('https://localhost/?android-layout=' + Date.now() + '#/' + path);
        await attach();
      } else {
        // The layout scan reuses this WebView between routes. Wait for the
        // navigation event and React's next frame before reading geometry.
        await page.evaluate(async (hash) => {
          if (location.hash === hash) return;
          await new Promise((resolve) => {
            addEventListener(
              'hashchange',
              () => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
              },
              { once: true },
            );
            location.hash = hash;
          });
        }, '#/' + path);
      }
      await until(async () => {
        const text = await page.locator('main').innerText();
        return (
          text.trim() &&
          !/^(?:正在加载|正在读取)/.test(text.trim()) &&
          !(await page.locator('main .loading:visible').count())
        );
      }, 'page content: ' + path);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    };
    const restart = async () => {
      await browser?.close().catch(() => {});
      adb('shell', 'am', 'force-stop', QA_PACKAGE);
      await connect();
      await attach();
    };
    return {
      adb,
      get page() {
        return page;
      },
      folder,
      original,
      errors,
      network,
      api,
      go,
      close,
      restart,
      serial,
      readExportFile(path) {
        assert.match(path, /^cache\/exports\/[a-f0-9-]+\/[A-Za-z0-9_.-]+$/);
        return execFileSync(
          adbPath,
          ['-s', serial, 'exec-out', 'run-as', QA_PACKAGE, 'cat', path],
          { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
        );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'QA connection failed and cleanup was incomplete',
      );
    }
    throw error;
  }
}
