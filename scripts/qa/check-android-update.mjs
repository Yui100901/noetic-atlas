/** Same-ID/signer APK replacement with retained native SQLite. Only .qa is owned. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveAndroidToolchain } from '../build/android-toolchain.mjs';
import { connectAndroid, QA_PACKAGE } from '../testing/android/device.mjs';
import { seedUpdateData, assertUpdateData } from './helpers/update-fixture.mjs';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    'baseline-apk': { type: 'string' },
    'update-apk': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'check-android-update.mjs --serial DEVICE --baseline-apk QA.apk --update-apk QA-newer.apk\nBoth APKs must be the fixed separate QA APK with the same signer and increasing versionCode. Only the disposable QA app is installed/cleared/uninstalled; production data is never opened.',
  );
  process.exit(0);
}
assert.ok(values.serial || process.env.ANDROID_SERIAL, 'Specify --serial or ANDROID_SERIAL');
assert.ok(values['baseline-apk'] && values['update-apk'], 'Specify both QA APK paths');
const root = resolve(import.meta.dirname, '../..'),
  folder = join(root, 'test-results/android-update'),
  windows = process.platform === 'win32',
  toolchain = resolveAndroidToolchain({}, { root }),
  adbPath =
    process.env.ANDROID_ADB ||
    join(toolchain.sdkRoot, 'platform-tools', windows ? 'adb.exe' : 'adb'),
  serial = values.serial || process.env.ANDROID_SERIAL;
await mkdir(folder, { recursive: true });
const run = (command, args, binary = false) =>
  execFileSync(command, args, {
    cwd: root,
    env: toolchain.env,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    ...(binary ? {} : { encoding: 'utf8' }),
  });
const adb = (...args) => String(run(adbPath, ['-s', serial, ...args])).trim(),
  digest = (value) => createHash('sha256').update(value).digest('hex');
async function inspectApk(path) {
  path = resolve(path);
  const aapt = join(toolchain.sdkRoot, 'build-tools/36.0.0', windows ? 'aapt2.exe' : 'aapt2'),
    badging = String(run(aapt, ['dump', 'badging', path])),
    name = badging.match(/package: name='([^']+)'/)?.[1],
    versionCode = Number(badging.match(/versionCode='(\d+)'/)?.[1]),
    versionName = badging.match(/versionName='([^']+)'/)?.[1];
  assert.equal(name, QA_PACKAGE, 'Refuse APKs outside the fixed QA application');
  assert.ok(Number.isSafeInteger(versionCode) && versionCode > 0);
  const proof = String(
    run(join(toolchain.javaRoot, 'bin', windows ? 'java.exe' : 'java'), [
      '-jar',
      join(toolchain.sdkRoot, 'build-tools/36.0.0/lib/apksigner.jar'),
      'verify',
      '--print-certs',
      path,
    ]),
  );
  const signer = proof.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/)?.[1];
  assert.ok(signer, 'Verified signing identity is required');
  return {
    path,
    package: name,
    versionCode,
    versionName,
    signer,
    sha256: digest(await readFile(path)),
  };
}
const installedInfo = (name) => {
  assert.ok([QA_PACKAGE, 'cn.noetic.atlas'].includes(name));
  const text = adb('shell', 'dumpsys', 'package', name);
  const identity = adb('shell', 'pm', 'list', 'packages', '-U', name)
    .split(/\r?\n/)
    .find((line) => line.startsWith('package:' + name + ' '));
  return {
    versionCode: text.match(/versionCode=(\d+)/)?.[1] || null,
    userId: identity?.match(/uid:(\d+)/)?.[1] || text.match(/(?:userId|appId)=(\d+)/)?.[1] || null,
    firstInstallTime: text.match(/firstInstallTime=([^\r\n]+)/)?.[1] || null,
    lastUpdateTime: text.match(/lastUpdateTime=([^\r\n]+)/)?.[1] || null,
  };
};
const content = async (api) => {
  const value = await api('/api/export');
  delete value.exportedAt;
  return value;
};
const databaseDigest = () =>
  digest(
    run(
      adbPath,
      ['-s', serial, 'exec-out', 'run-as', QA_PACKAGE, 'cat', 'files/learning.sqlite'],
      true,
    ),
  );
const report = {
  ok: false,
  isolated: true,
  serial,
  package: QA_PACKAGE,
  checks: [],
  scope: 'same-source QA APK manifest version increase; no historical schema conversion',
};
let device,
  installed = false;
try {
  report.baseline = await inspectApk(values['baseline-apk']);
  report.update = await inspectApk(values['update-apk']);
  assert.equal(report.baseline.signer, report.update.signer, 'Signer must remain identical');
  assert.ok(
    report.update.versionCode > report.baseline.versionCode,
    'Update versionCode must increase',
  );
  report.productionBefore = installedInfo('cn.noetic.atlas');
  report.device = {
    model: adb('shell', 'getprop', 'ro.product.model'),
    androidVersion: adb('shell', 'getprop', 'ro.build.version.release'),
    sdk: adb('shell', 'getprop', 'ro.build.version.sdk'),
  };
  // Only this separately identified installation is disposable, including an
  // earlier QA build whose code might be higher than the new release baseline.
  if (
    adb('shell', 'pm', 'list', 'packages', QA_PACKAGE)
      .split(/\r?\n/)
      .includes('package:' + QA_PACKAGE)
  )
    adb('uninstall', QA_PACKAGE);
  assert.match(adb('install', '-r', report.baseline.path), /Success/);
  installed = true;
  report.installedBaseline = installedInfo(QA_PACKAGE);
  assert.ok(report.installedBaseline.userId, 'Installed QA app UID must be observable');
  device = await connectAndroid({ serial, clearDataOnClose: false });
  assert.equal((await device.api('/api/bootstrap')).stats.totalQuestions, 0);
  const state = await seedUpdateData(device.api);
  await assertUpdateData(device.api, state);
  const before = await content(device.api),
    beforeAi = await device.api('/api/ai/settings');
  assert.equal(beforeAi.hasKey, true);
  assert.ok(before.questions.length >= 17 && before.attempts.length >= 2);
  assert.ok(before.study.some((item) => item.favorite && item.notes));
  assert.ok(before.questionHistory.length > 0 && before.reviewCards.length > 0);
  assert.equal(device.errors.length, 0);
  assert.equal(device.network.length, 0);
  await device.close();
  device = undefined;
  report.checks.push('baseline data saved; application stopped without clearing its QA database');
  report.databaseBeforeInstall = databaseDigest();
  assert.match(adb('install', '-r', report.update.path), /Success/);
  report.databaseAfterInstall = databaseDigest();
  assert.equal(report.databaseAfterInstall, report.databaseBeforeInstall);
  report.installedUpdate = installedInfo(QA_PACKAGE);
  assert.equal(Number(report.installedUpdate.versionCode), report.update.versionCode);
  assert.equal(report.installedUpdate.userId, report.installedBaseline.userId);
  assert.equal(report.installedUpdate.firstInstallTime, report.installedBaseline.firstInstallTime);
  report.checks.push(
    'higher-code same-signer replacement retains app UID and exact SQLite bytes before launch',
  );
  device = await connectAndroid({ serial, resetData: false });
  const after = await content(device.api);
  assert.deepEqual(after, before);
  assert.deepEqual(await device.api('/api/ai/settings'), beforeAi);
  await assertUpdateData(device.api, state);
  assert.equal((await device.api('/api/attempts/' + state.draftId)).status, 'in_progress');
  assert.equal((await device.api('/api/attempts/' + state.submittedId)).status, 'submitted');
  report.counts = Object.fromEntries(
    Object.entries(after)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, rows]) => [key, rows.length]),
  );
  report.checks.push(
    'all exported learning content, answers, drafts, review state and settings survive reopening',
  );
  await device.api('/api/study/ANDROID-LAYOUT-0', 'PUT', { notes: '更新后仍可保存笔记。' });
  await device.restart();
  assert.equal(
    (await device.api('/api/questions/ANDROID-LAYOUT-0')).study.notes,
    '更新后仍可保存笔记。',
  );
  assert.equal((await device.api('/api/papers/' + state.paperId)).questionIds.length, 17);
  assert.equal(device.errors.length, 0);
  assert.equal(device.network.length, 0);
  report.checks.push('post-update writes survive another process restart');
  await device.close();
  device = undefined;
  report.productionAfter = installedInfo('cn.noetic.atlas');
  assert.deepEqual(report.productionAfter, report.productionBefore);
  report.checks.push('production application identity and installation times unchanged');
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  try {
    await device?.close();
    if (installed) adb('uninstall', QA_PACKAGE);
    report.qaUninstalled = installed;
  } catch (error) {
    report.ok = false;
    report.cleanupError = error.stack;
    throw error;
  } finally {
    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        ok: report.ok,
        checks: report.checks.length,
        report: join(folder, 'report.json'),
      }),
    );
  }
}
