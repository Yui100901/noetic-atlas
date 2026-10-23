/** Resolve one validated Android toolchain for building and signature verification. */
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = resolve(import.meta.dirname, '../..');

export function resolveAndroidToolchain(options = {}, {
  root = projectRoot, env = process.env, platform = process.platform, home = homedir(),
  exists = existsSync, realpath = realpathSync, execute = spawnSync,
} = {}) {
  const suffix = platform === 'win32' ? '.exe' : '';
  const separator = platform === 'win32' ? ';' : ':';
  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = env[pathName] || '';
  const javaError = '需要 Java 21 完整 JDK，请设置 JAVA_HOME、将 JDK 的 bin 加入 PATH，或通过 --java-root 指定';
  const javaHome = options.javaRoot || env.JAVA_HOME;
  const explicitJava = Boolean(javaHome);
  const javaCandidates = explicitJava
    ? [join(resolve(root, javaHome), `bin/java${suffix}`)]
    : originalPath.split(separator).filter(Boolean).map(directory => join(resolve(root, directory.replace(/^"(.*)"$/, '$1')), `java${suffix}`));

  let javaRoot;
  for (const candidate of javaCandidates) {
    if (!exists(candidate)) continue;
    let executable;
    try { executable = realpath(candidate); } catch { continue; }
    // java.home also resolves launcher shims such as Windows javapath and /usr/bin/java.
    const result = execute(executable, ['-XshowSettings:properties', '-version'], {
      env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) continue;
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const specification = text.match(/^\s*java\.specification\.version\s*=\s*(\S+)\s*$/m)?.[1];
    if (specification ? specification !== '21' : !/(?:openjdk|java)\s+(?:version\s+")?21(?:[.\s"]|$)/i.test(text)) continue;
    const reportedHome = text.match(/^\s*java\.home\s*=\s*(.+?)\s*$/m)?.[1];
    const detectedRoot = explicitJava ? resolve(root, javaHome) : reportedHome ? resolve(root, reportedHome) : dirname(dirname(executable));
    if (!['java', 'javac', 'keytool'].every(name => exists(join(detectedRoot, `bin/${name}${suffix}`)))) continue;
    javaRoot = detectedRoot;
    break;
  }
  if (!javaRoot) throw new Error(javaError);

  // An explicitly selected installation never silently falls back to another SDK.
  const selectedSdk = options.sdkRoot || env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const sdkCandidates = selectedSdk ? [selectedSdk] : [
    join(root, '.localtools/android-sdk'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android/Sdk'),
    join(home, 'Android/Sdk'), join(home, 'Library/Android/sdk'),
  ].filter(Boolean);
  const sdkRoot = sdkCandidates.map(path => resolve(root, path)).find(path => [
    'platforms/android-36/android.jar', `build-tools/36.0.0/aapt2${suffix}`,
    `build-tools/36.0.0/zipalign${suffix}`, 'build-tools/36.0.0/lib/apksigner.jar',
  ].every(file => exists(join(path, file))));
  if (!sdkRoot) throw new Error('需要 Android SDK API 36 和完整 build-tools 36.0.0（aapt2、zipalign、apksigner），请通过 --sdk-root 或 ANDROID_HOME 指定');

  // Avoid duplicate Path/PATH keys on Windows: the child process must use this JDK.
  const buildEnv = Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  Object.assign(buildEnv, {
    JAVA_HOME: javaRoot, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot,
    GRADLE_USER_HOME: join(root, '.localtools/gradle-home'), PATH: `${join(javaRoot, 'bin')}${separator}${originalPath}`,
  });
  return { javaRoot, sdkRoot, env: buildEnv };
}
