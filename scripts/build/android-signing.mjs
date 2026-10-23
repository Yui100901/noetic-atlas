/** Local release identity. Private files never belong in Git or release assets. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '../..');
const variables = ['ANDROID_KEYSTORE', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
export const signingDirectory = root => join(root, '.localtools/signing/release');
const profilePath = root => join(signingDirectory(root), 'signing.json');

export async function resolveAndroidSigningEnvironment({ root = projectRoot, env = process.env } = {}) {
  const result = { ...env };
  if (variables.some(name => result[name] !== undefined)) {
    if (variables.some(name => typeof result[name] !== 'string' || !result[name].trim())) throw new Error('正式签名环境变量必须完整设置四项，不会与本地配置混用');
    result.ANDROID_KEYSTORE = resolve(root, result.ANDROID_KEYSTORE);
  } else if (existsSync(profilePath(root))) {
    let profile;
    try { profile = JSON.parse(await readFile(profilePath(root), 'utf8')); }
    catch { throw new Error('本地签名配置无法读取，请检查私有 signing.json；不会创建替代密钥'); }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.schemaVersion !== 1 || !/^[\w-]+\.(?:p12|jks|keystore)$/.test(profile.keystore || '')
      || ['storePassword', 'keyPassword', 'keyAlias'].some(name => typeof profile[name] !== 'string' || !profile[name].trim())
      || !/^[a-f0-9]{64}$/.test(profile.certificateSha256 || '')) throw new Error('本地签名配置不完整；请恢复原有密钥与配置，不要重新生成');
    result.ANDROID_KEYSTORE = join(signingDirectory(root), profile.keystore);
    result.ANDROID_STORE_PASSWORD = profile.storePassword;
    result.ANDROID_KEY_PASSWORD = profile.keyPassword;
    result.ANDROID_KEY_ALIAS = profile.keyAlias;
    result.NOETIC_ANDROID_CERTIFICATE_SHA256 = profile.certificateSha256;
  } else if (existsSync(signingDirectory(root))) {
    throw new Error('正式签名目录存在但配置缺失；请恢复原有 signing.json，不会退回未签名构建');
  }
  if (result.ANDROID_KEYSTORE && !existsSync(result.ANDROID_KEYSTORE)) throw new Error('正式签名密钥文件不存在，请恢复原有密钥；不会创建替代密钥');
  return result;
}

function runTool(command, args, env, binary = false) {
  const result = spawnSync(command, args, { env, shell: false, windowsHide: true, ...(binary ? {} : { encoding: 'utf8' }), maxBuffer: 8 * 1024 * 1024 });
  // Never echo arguments, environment or stderr from credential-consuming tools.
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} 执行失败（${result.status ?? '无法启动'}），请检查工具链和签名凭据`);
  return result.stdout;
}

function javaTool(name, javaRoot, env) {
  const directory = javaRoot || env.JAVA_HOME;
  return directory ? join(resolve(directory), 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
}

export function readSigningCertificate({ env, javaRoot } = {}) {
  const bytes = runTool(javaTool('keytool', javaRoot, env), ['-exportcert', '-keystore', env.ANDROID_KEYSTORE,
    '-alias', env.ANDROID_KEY_ALIAS, '-storepass:env', 'ANDROID_STORE_PASSWORD'], env, true);
  const certificate = new X509Certificate(bytes);
  const sha256 = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  if (/CN\s*=\s*Android Debug/i.test(certificate.subject) || env.ANDROID_KEY_ALIAS === 'androiddebugkey') throw new Error('正式发布不能使用 Android 调试签名');
  if (env.NOETIC_ANDROID_CERTIFICATE_SHA256 && sha256 !== env.NOETIC_ANDROID_CERTIFICATE_SHA256) throw new Error('签名证书指纹与本地记录不一致，已停止构建');
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('正式签名证书已到期');
  return { sha256, subject: certificate.subject, validFrom: certificate.validFrom, validTo: certificate.validTo, keyType: certificate.publicKey.asymmetricKeyType, keySize: certificate.publicKey.asymmetricKeyDetails?.modulusLength };
}

async function protectDirectory(directory, env) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = runTool('whoami.exe', ['/user', '/fo', 'csv', '/nh'], env).match(/S-1-\d+(?:-\d+)+/);
    if (!identity) throw new Error('无法确认当前 Windows 用户，未创建签名凭据');
    runTool('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${identity[0]}:(OI)(CI)F`], env);
  } else await chmod(directory, 0o700);
}

export async function initializeAndroidSigning({ root = projectRoot, env = process.env, javaRoot } = {}) {
  const directory = signingDirectory(root), profileFile = profilePath(root), keystore = join(directory, 'noetic-atlas-release.p12');
  if (existsSync(profileFile) || existsSync(keystore)) throw new Error('正式签名已存在，禁止覆盖；后续版本请沿用原密钥');
  if (variables.some(name => env[name] !== undefined)) throw new Error('环境中已有签名配置，请沿用该密钥，未创建新密钥');
  await protectDirectory(directory, env);
  const lock = join(directory, '.init.lock');
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  try {
    const password = randomBytes(32).toString('base64url');
    const profile = { schemaVersion: 1, keystore: basename(keystore), keyAlias: 'noetic-atlas', storePassword: password, keyPassword: password, createdAt: new Date().toISOString() };
    // Persist the random password before key generation so an interruption cannot
    // leave a generated key whose password has been lost. Partial setup fails closed.
    await writeFile(profileFile, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const signingEnv = { ...env, ANDROID_KEYSTORE: keystore, ANDROID_KEY_ALIAS: profile.keyAlias, ANDROID_STORE_PASSWORD: password, ANDROID_KEY_PASSWORD: password };
    runTool(javaTool('keytool', javaRoot, env), ['-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', keystore,
      '-alias', profile.keyAlias, '-storepass:env', 'ANDROID_STORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD',
      '-dname', 'CN=Noetic Atlas,O=Noetic Atlas', '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA256withRSA', '-validity', '10000'], signingEnv);
    await chmod(keystore, 0o600);
    const certificate = readSigningCertificate({ env: signingEnv, javaRoot });
    profile.certificateSha256 = certificate.sha256;
    await writeFile(profileFile, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(directory, 'BACKUP.txt'), 'PRIVATE: back up this entire directory to encrypted/offline storage.\nKeep both noetic-atlas-release.p12 and signing.json. Never publish either file.\nFuture updates must use the same key. Restore this directory on a new machine.\n', { mode: 0o600 });
    return { directory, keystore, profile: profileFile, certificate };
  } finally { await unlink(lock); }
}

export function parseApkSignerOutput(output, expectedSha256) {
  const fingerprints = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]+)\s*$/gim)].map(match => match[1].toLowerCase());
  if (fingerprints.length !== 1 || fingerprints[0] !== expectedSha256) throw new Error('APK 签名证书与指定的正式密钥不一致');
  const schemes = Object.fromEntries(['1', '2', '3', '3.1', '4'].map(version => [`v${version.replace('.', '')}`, new RegExp(`Verified using v${version.replace('.', '\\.')} scheme[^\\r\\n]*: true`, 'i').test(output)]));
  if (!schemes.v2) throw new Error('APK 缺少 Android 7+ 所需的 v2 正式签名');
  return { certificateSha256: fingerprints[0], schemes };
}

export async function verifySignedApk({ root = projectRoot, env = process.env, javaRoot, sdkRoot, apk = join(root, 'artifacts/noetic-atlas-release.apk') } = {}) {
  const signingEnv = await resolveAndroidSigningEnvironment({ root, env });
  if (!signingEnv.ANDROID_KEYSTORE) throw new Error('尚未配置正式签名，请先运行 npm run android:signing:init');
  const certificate = readSigningCertificate({ env: signingEnv, javaRoot });
  const candidates = [sdkRoot, env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(root, '.localtools/android-sdk'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android/Sdk'), join(homedir(), 'Android/Sdk'), join(homedir(), 'Library/Android/sdk')].filter(Boolean);
  const sdk = sdkRoot || candidates.find(path => existsSync(join(path, 'build-tools/36.0.0/lib/apksigner.jar')));
  if (!sdk) throw new Error('签名验证需要 Android SDK Build Tools 36.0.0');
  const tools = join(resolve(root, sdk), 'build-tools/36.0.0');
  apk = resolve(root, apk);
  const output = runTool(javaTool('java', javaRoot, signingEnv), ['-jar', join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk], signingEnv);
  const signature = parseApkSignerOutput(output, certificate.sha256);
  runTool(join(tools, 'zipalign' + (process.platform === 'win32' ? '.exe' : '')), ['-c', '-P', '16', '4', apk], signingEnv);
  const bytes = await readFile(apk);
  const report = { apk: basename(apk), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), signed: true, signatureVerified: true, alignmentVerified: true, ...signature, certificate, verifiedAt: new Date().toISOString(), deviceTested: false };
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/android-signing-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const action = args.shift(), options = {};
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (!['--java-root', '--sdk-root', '--apk'].includes(name) || !value || value.startsWith('--')) throw new Error('用法：android-signing.mjs init|verify [--java-root JDK路径] [--sdk-root SDK路径] [--apk APK路径]');
    options[{ '--java-root': 'javaRoot', '--sdk-root': 'sdkRoot', '--apk': 'apk' }[name]] = resolve(value);
  }
  const result = action === 'init' ? await initializeAndroidSigning(options) : action === 'verify' ? await verifySignedApk(options) : null;
  if (!result) throw new Error('请选择 init 或 verify');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Android 签名终止：${error.message}`); process.exitCode = 1; });
}
