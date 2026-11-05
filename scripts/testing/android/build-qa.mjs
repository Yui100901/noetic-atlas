/** A separately identified test APK; never copies into release artifacts. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, cp, copyFile, rm, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { verifyQaAssets } from './verify-assets.mjs';
import { resolveAndroidToolchain } from '../../build/android-toolchain.mjs';
import { findNpmCli } from '../../build/build-command.mjs';

const { values } = parseArgs({
  options: {
    'java-root': { type: 'string' },
    'sdk-root': { type: 'string' },
    'skip-sync': { type: 'boolean' },
    offline: { type: 'boolean' },
    install: { type: 'boolean' },
    serial: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'build-qa.mjs [--java-root JDK21] [--sdk-root SDK] [--offline] [--skip-sync] [--install --serial DEVICE]\nOutputs test-results/android-layout/noetic-atlas-qa.apk; production assets are restored even if the build fails.',
  );
  process.exit(0);
}
const root = resolve(import.meta.dirname, '../../..'),
  folder = join(root, 'test-results/android-layout'),
  out = join(folder, 'app-assets');
const toolchain = resolveAndroidToolchain(
  { javaRoot: values['java-root'], sdkRoot: values['sdk-root'] },
  { root },
);
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: toolchain.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20 * 60 * 1000,
    killSignal: 'SIGTERM',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('QA build step failed: ' + command);
  return result.stdout;
}
await mkdir(folder, { recursive: true });
if (!values['skip-sync']) run(process.execPath, [findNpmCli(), 'run', 'mobile:sync']);
assert.ok(
  existsSync(join(root, 'dist/mobile/index.html')),
  'Build production mobile resources first',
);
let prepared = false;
async function clearGeneratedDirectory(path, expected) {
  assert.equal(relative(root, path).replaceAll('\\', '/'), expected);
  if (existsSync(path))
    assert.equal(
      (await lstat(path)).isSymbolicLink(),
      false,
      'Generated assets must not be a symlink',
    );
  await rm(path, { recursive: true, force: true });
}
try {
  prepared = true;
  // Vite's programmatic public copy can retain obsolete public files. Build
  // from an empty, explicitly owned output rather than merging previous runs.
  await clearGeneratedDirectory(out, 'test-results/android-layout/app-assets');
  await build({
    root,
    configFile: join(root, 'vite.mobile.config.ts'),
    build: {
      outDir: out,
      manifest: true,
      rolldownOptions: {
        input: {
          main: join(root, 'index.html'),
          qa: join(root, 'scripts/testing/android/entry.ts'),
        },
        preserveEntrySignatures: 'strict',
      },
    },
  });
  const manifest = JSON.parse(await readFile(join(out, '.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((item) => item.isEntry && item.name === 'qa');
  assert.ok(entry, 'QA entry missing');
  await writeFile(
    join(out, 'qa-entry.json'),
    JSON.stringify({ entry: entry.file, package: 'cn.noetic.atlas.qa' }),
  );
  const androidAssets = join(root, 'android/app/src/main/assets/public');
  // This exact generated directory is owned by Capacitor; merging leaves old
  // production chunks next to the QA graph and inflates the APK.
  await clearGeneratedDirectory(androidAssets, 'android/app/src/main/assets/public');
  await cp(out, androidAssets, { recursive: true });
  const init = join(root, 'scripts/testing/android/qa.init.gradle'),
    windows = process.platform === 'win32';
  const local = join(root, '.localtools/gradle-8.14.3/bin', windows ? 'gradle.bat' : 'gradle');
  const gradle = existsSync(local)
    ? local
    : join(root, 'android', windows ? 'gradlew.bat' : 'gradlew');
  if (windows)
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'scripts/testing/android/gradle-qa.ps1'),
        '-GradlePath',
        gradle,
        '-InitScript',
        init,
        ...(values.offline ? ['-Offline'] : []),
      ],
      join(root, 'android'),
    );
  else
    run(
      gradle,
      [
        ...(values.offline ? ['--offline'] : []),
        '--no-daemon',
        '--init-script',
        init,
        ':app:clean',
        ':app:assembleDebug',
      ],
      join(root, 'android'),
    );
  const apk = join(folder, 'noetic-atlas-qa.apk');
  await copyFile(join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), apk);
  const aapt = join(toolchain.sdkRoot, 'build-tools/36.0.0', windows ? 'aapt2.exe' : 'aapt2');
  assert.match(
    run(aapt, ['dump', 'badging', apk], root, true),
    /package: name='cn\.noetic\.atlas\.qa'/,
  );
  await verifyQaAssets(new Uint8Array(await readFile(apk)), out);
  await writeFile(
    join(folder, 'build.json'),
    JSON.stringify({ apk, entry: entry.file, package: 'cn.noetic.atlas.qa' }, null, 2),
  );
  if (values.install) {
    assert.ok(values.serial || process.env.ANDROID_SERIAL, 'Specify --serial for installation');
    run(join(toolchain.sdkRoot, 'platform-tools', windows ? 'adb.exe' : 'adb'), [
      '-s',
      values.serial || process.env.ANDROID_SERIAL,
      'install',
      '-r',
      apk,
    ]);
  }
  console.log(JSON.stringify({ apk, package: 'cn.noetic.atlas.qa' }));
} finally {
  if (prepared)
    run(process.execPath, [
      join(root, 'node_modules/@capacitor/cli/bin/capacitor'),
      'copy',
      'android',
    ]);
}
