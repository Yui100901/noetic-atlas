/** Real WebView layout QA at the operator's current device resolution/density. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectAndroid, until } from '../testing/android/device.mjs';
import { seedAndroidLayout } from '../testing/android/layout-fixture.mjs';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    entry: { type: 'string' },
    ime: { type: 'string' },
    exports: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'check-android-layout.mjs --serial DEVICE [--entry assets/qa-HASH.js] [--ime PACKAGE/SERVICE] [--exports]\nRequires the separate QA APK. Uses its disposable data only; snapshots/restores display, rotation, font and keyboard settings. No AI or work database access.',
  );
  process.exit(0);
}
const folder = resolve(import.meta.dirname, '../../test-results/android-layout');
await mkdir(folder, { recursive: true });
let device, page, adb, api, go;
const report = {
  startedAt: new Date().toISOString(),
  status: 'running',
  profiles: [],
  samples: [],
  findings: [],
  errors: [],
  externalNetwork: [],
};
await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
const screenshot = async (name) => {
  if (page) await page.screenshot({ path: join(folder, name + '.png') });
};
async function geometry(label) {
  const result = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        s.opacity !== '0'
      );
    };
    const describe = (el) =>
      (el.getAttribute('aria-label') || el.textContent || el.className)
        .toString()
        .trim()
        .slice(0, 80);
    const issues = [];
    if (document.documentElement.scrollWidth > innerWidth + 1)
      issues.push({
        kind: 'horizontal-overflow',
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('main *')]
          .filter(visible)
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 2)
          .slice(0, 6)
          .map(describe),
      });
    for (const el of document.querySelectorAll('main [role=alert],main .fatal-error'))
      if (visible(el)) issues.push({ kind: 'page-error', text: describe(el) });
    const controls = [
      ...document.querySelectorAll(
        'main button,main a.button,main select,main input:not([type=hidden]),main textarea',
      ),
    ]
      .filter(visible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
      });
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i],
          b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        // Sticky save bars intentionally float above scrolling form fields.
        if (
          a.closest('.form-save-bar,.paper-mobile-toolbar') ||
          b.closest('.form-save-bar,.paper-mobile-toolbar')
        )
          continue;
        const r = a.getBoundingClientRect(),
          s = b.getBoundingClientRect();
        if (
          Math.min(r.right, s.right) - Math.max(r.left, s.left) > 4 &&
          Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) > 4
        )
          issues.push({ kind: 'overlapping-controls', a: describe(a), b: describe(b) });
      }
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      visualHeight: visualViewport.height,
      scrollWidth: document.documentElement.scrollWidth,
      issues,
    };
  });
  report.samples.push({ label, ...result });
  for (const issue of result.issues) report.findings.push({ label, ...issue });
  return result;
}
try {
  device = await connectAndroid(values);
  ({ adb, api, go } = device);
  page = device.page;
  Object.assign(report, {
    serial: device.serial,
    original: device.original,
    errors: device.errors,
    externalNetwork: device.network,
  });
  const empty = await api('/api/bootstrap');
  assert.equal(empty.stats.totalQuestions, 0);
  const state = await seedAndroidLayout(api);
  const routes = [
    ['overview', ''],
    ['questions', 'questions'],
    ['question', 'questions/ANDROID-LAYOUT-0'],
    ['question-edit', 'questions/ANDROID-LAYOUT-0/edit'],
    ['group', 'questions/ANDROID-LAYOUT-GROUP'],
    ['review', 'questions/review'],
    ['quality', 'content-quality'],
    ['question-import', 'questions/import'],
    ['papers', 'papers'],
    ['paper', 'papers/' + state.paperId],
    ['paper-reader', 'papers/' + state.paperId + '/questions/ANDROID-LAYOUT-0'],
    ['manual', 'papers/new'],
    ['random', 'papers/new/random'],
    ['attempt', 'attempts/' + state.draftId],
    ['submitted', 'attempts/' + state.submittedId],
    ['focus', 'focus-review/' + state.focusId],
    ['wrong', 'learning/wrong'],
    ['favorite', 'learning/favorite'],
    ['documents', 'documents'],
    ['document', 'documents/' + state.documentId],
    ['document-edit', 'documents/' + state.documentId + '/edit'],
    ['taxonomy', 'taxonomy'],
    ['search', 'search?q=事务'],
    ['analytics', 'analytics'],
    ['sharing', 'sharing'],
    ['ai', 'ai?tab=import'],
    ['settings', 'settings'],
    ['settings-practice', 'settings?tab=practice'],
    ['settings-ai', 'settings?tab=ai'],
    ['settings-backup', 'settings?tab=backup&sub=backup'],
    ['settings-health', 'settings?tab=backup&sub=health'],
    ['help', 'help'],
  ];
  for (const profile of [
    { name: 'portrait', rotation: 0, font: '1.0' },
    { name: 'landscape', rotation: 1, font: '1.0' },
    { name: 'large-font', rotation: 0, font: '1.3' },
  ]) {
    adb('shell', 'settings', 'put', 'system', 'font_scale', profile.font);
    adb('shell', 'wm', 'user-rotation', 'lock', String(profile.rotation));
    await device.restart();
    page = device.page;
    await until(
      () =>
        page.evaluate(
          (landscape) => (landscape ? innerWidth > innerHeight : innerHeight > innerWidth),
          profile.rotation === 1,
        ),
      'native orientation',
    );
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
    }));
    report.profiles.push({ ...profile, ...dimensions });
    for (const [name, path] of routes) {
      await go(path);
      await geometry(profile.name + '-' + name);
      if (['overview', 'question', 'manual', 'document-edit', 'settings', 'attempt'].includes(name))
        await screenshot(profile.name + '-' + name);
      if (
        [
          'question-edit',
          'manual',
          'random',
          'document-edit',
          'settings-practice',
          'settings-ai',
          'settings-backup',
        ].includes(name)
      ) {
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await geometry(profile.name + '-' + name + '-bottom');
      }
      await writeFile(
        join(folder, 'progress.json'),
        JSON.stringify(
          {
            profile: profile.name,
            page: name,
            samples: report.samples.length,
            findings: report.findings,
          },
          null,
          2,
        ),
      );
    }
    // The navigation drawer must open, remain within the viewport and close.
    await go('questions');
    const menu = page.getByRole('button', { name: '打开菜单', exact: true });
    if (await menu.isVisible()) {
      await menu.click();
      const scrim = page.getByRole('button', { name: '关闭导航', exact: true });
      await scrim.waitFor();
      await until(async () => {
        const nav = await page.locator('.sidebar').boundingBox();
        return nav && nav.x >= -1 && nav.x + nav.width <= dimensions.width + 1;
      }, 'navigation drawer animation');
      const nav = await page.locator('.sidebar').boundingBox();
      assert.ok(nav && nav.x >= -1 && nav.x + nav.width <= dimensions.width + 1);
      await scrim.click({ position: { x: dimensions.width - 10, y: 30 } });
      await scrim.waitFor({ state: 'hidden' });
    } else {
      const nav = await page.locator('.sidebar').boundingBox();
      assert.ok(nav && nav.x >= -1 && nav.x + nav.width <= dimensions.width + 1);
    }
    console.log(
      JSON.stringify({
        profile: profile.name,
        ...dimensions,
        samples: report.samples.length,
        findings: report.findings.length,
      }),
    );
  }
  if (values.ime) {
    await go('documents/' + state.documentId + '/edit');
    const input = page.locator('textarea:visible').first();
    await input.waitFor();
    const before = await page.evaluate(() => visualViewport.height);
    await input.click();
    await until(
      () => page.evaluate((before) => visualViewport.height < before - 70, before),
      'visible Android IME',
    );
    const viewport = await page.evaluate(() => ({
        height: visualViewport.height,
        offset: visualViewport.offsetTop,
      })),
      bar = await page.locator('.form-save-bar').boundingBox();
    assert.ok(
      bar && bar.y + bar.height <= viewport.height + viewport.offset + 3,
      'Save bar is hidden by the keyboard',
    );
    await geometry('keyboard-document-edit');
    await screenshot('keyboard-document-edit');
    adb('shell', 'input', 'keyevent', '4');
    report.keyboard = { before, after: viewport.height, saveBarVisible: true };
  }
  if (values.exports) {
    const document = await api('/api/papers/' + state.paperId + '/export-document?mode=answers');
    document.filename = 'android-export-qa';
    report.exports = [];
    for (const format of ['pdf', 'md']) {
      await page.evaluate(
        async ({ document, format }) => window.__noeticQA.downloadExport(document, format),
        { document, format },
      );
      assert.match(
        adb('shell', 'dumpsys', 'activity', 'activities'),
        /ChooserActivity|ResolverActivity|IntentResolver/,
      );
      const path = adb(
        'shell',
        'run-as',
        'cn.noetic.atlas.qa',
        'find',
        'cache/exports',
        '-type',
        'f',
      )
        .split(/\r?\n/)
        .find((path) => path.endsWith('/android-export-qa.' + format));
      assert.ok(path, 'Native export did not create a cache copy');
      const bytes = device.readExportFile(path);
      await writeFile(join(folder, 'native-export.' + format), bytes);
      const evidence = { format, bytes: bytes.length, systemShareOpened: true };
      if (format === 'pdf') {
        const { PDFDocument } = await import('pdf-lib');
        const pdf = await PDFDocument.load(bytes);
        assert.ok(pdf.getPageCount() > 0);
        evidence.pages = pdf.getPageCount();
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loading = getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
        try {
          const reader = await loading.promise;
          let text = '';
          for (let index = 1; index <= reader.numPages; index++) {
            const page = await reader.getPage(index);
            text += (await page.getTextContent()).items.map((item) => item.str || '').join('');
          }
          assert.match(text, /事务/);
          assert.match(text, /程序阅读/);
          evidence.chineseTextPreserved = true;
        } finally {
          await loading.destroy();
        }
      } else {
        assert.match(bytes.toString('utf8'), /事务/);
      }
      report.exports.push(evidence);
      adb('shell', 'input', 'keyevent', '4');
    }
  }
  assert.deepEqual(report.findings, []);
  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.network, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error.stack || error);
  await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    if (device) {
      await device.close();
      report.deviceRestored = true;
    }
  } catch (error) {
    report.ok = false;
    report.cleanupError = String(error.message);
    process.exitCode = 1;
  }
  report.status = report.ok ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ok: report.ok,
      profiles: report.profiles.length,
      samples: report.samples.length,
      findings: report.findings.length,
      deviceRestored: report.deviceRestored,
    }),
  );
}
