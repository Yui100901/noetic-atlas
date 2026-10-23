import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
// @ts-expect-error Build helpers intentionally use plain JavaScript.
import { initializeAndroidSigning, parseApkSignerOutput, resolveAndroidSigningEnvironment, signingDirectory } from '../../scripts/build/android-signing.mjs';

const certificateSha256 = 'ab'.repeat(32);
const signatureVariables = ['ANDROID_KEYSTORE', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'] as const;

async function fixture(t: test.TestContext) {
  const temporaryRoot = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, 'atlas-signing-test-'));
  t.after(async () => {
    const insideTemporaryRoot = relative(temporaryRoot, resolve(root));
    assert.ok(insideTemporaryRoot.startsWith('atlas-signing-test-') && !insideTemporaryRoot.startsWith('..') && !isAbsolute(insideTemporaryRoot));
    await rm(root, { recursive: true, force: true });
  });
  const directory = signingDirectory(root);
  const profileFile = join(directory, 'signing.json');
  const profile = {
    schemaVersion: 1,
    keystore: 'noetic-atlas-release.p12',
    keyAlias: 'atlas-test-only',
    storePassword: 'synthetic-test-password',
    keyPassword: 'synthetic-test-password',
    certificateSha256,
  };
  const saveProfile = async (value: unknown = profile) => {
    await mkdir(directory, { recursive: true });
    await writeFile(profileFile, JSON.stringify(value));
  };
  const createKeystorePlaceholder = async (name = profile.keystore) => {
    await mkdir(directory, { recursive: true });
    const keystore = join(directory, name);
    await writeFile(keystore, 'test placeholder, never a private key');
    return keystore;
  };
  return { root, directory, profileFile, profile, saveProfile, createKeystorePlaceholder };
}

function apkSignerOutput({ digest = certificateSha256, v1 = false, v2 = true, v3 = true, v31 = false, v4 = false, extraSigner = '' } = {}) {
  return `Verifies\nVerified using v1 scheme (JAR signing): ${v1}\nVerified using v2 scheme (APK Signature Scheme v2): ${v2}\nVerified using v3 scheme (APK Signature Scheme v3): ${v3}\nVerified using v3.1 scheme (APK Signature Scheme v3.1): ${v31}\nVerified using v4 scheme (APK Signature Scheme v4): ${v4}\nNumber of signers: ${extraSigner ? 2 : 1}\nSigner #1 certificate DN: CN=Noetic Atlas, O=Noetic Atlas\nSigner #1 certificate SHA-256 digest: ${digest}\n${extraSigner}`;
}

test('Android signing resolver leaves clean installations unsigned without creating an identity', async t => {
  const { root } = await fixture(t);
  const env = { PATH: 'synthetic-path', PUBLIC_BUILD_FLAG: '1' };
  const result = await resolveAndroidSigningEnvironment({ root, env });
  assert.deepEqual(result, env);
  assert.notEqual(result, env);
  assert.deepEqual(await readdir(root), []);
});

test('Android signing resolver resolves a complete explicit environment without mutating its caller', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'external-release.jks'), 'external test placeholder');
  const env = Object.freeze({
    ANDROID_KEYSTORE: 'external-release.jks',
    ANDROID_STORE_PASSWORD: 'synthetic-store-password',
    ANDROID_KEY_ALIAS: 'external-test-key',
    ANDROID_KEY_PASSWORD: 'synthetic-key-password',
    PATH: 'synthetic-path',
  });
  const result = await resolveAndroidSigningEnvironment({ root, env });
  assert.equal(result.ANDROID_KEYSTORE, join(root, 'external-release.jks'));
  assert.equal(result.ANDROID_STORE_PASSWORD, env.ANDROID_STORE_PASSWORD);
  assert.equal(result.ANDROID_KEY_ALIAS, env.ANDROID_KEY_ALIAS);
  assert.equal(result.ANDROID_KEY_PASSWORD, env.ANDROID_KEY_PASSWORD);
  assert.equal(result.PATH, env.PATH);
  assert.equal(env.ANDROID_KEYSTORE, 'external-release.jks');
});

test('Android signing resolver never combines partial environment credentials with a local identity', async t => {
  const { root, saveProfile, createKeystorePlaceholder } = await fixture(t);
  await saveProfile();
  await createKeystorePlaceholder();
  for (const variable of signatureVariables) {
    await assert.rejects(resolveAndroidSigningEnvironment({ root, env: { [variable]: 'synthetic-only-one-variable' } }), /完整设置四项/);
  }
  const complete = { ANDROID_KEYSTORE: 'unused.p12', ANDROID_STORE_PASSWORD: 'test', ANDROID_KEY_ALIAS: 'test', ANDROID_KEY_PASSWORD: 'test' };
  for (const variable of signatureVariables) {
    for (const value of ['', '   ']) {
      await assert.rejects(resolveAndroidSigningEnvironment({ root, env: { ...complete, [variable]: value } }), /完整设置四项/);
    }
  }
});

test('Android signing resolver gives a complete explicit identity precedence over a broken local profile', async t => {
  const { root, profileFile, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  await writeFile(profileFile, 'invalid local JSON');
  const keystore = join(root, 'external.p12');
  await writeFile(keystore, 'external test placeholder');
  const result = await resolveAndroidSigningEnvironment({ root, env: {
    ANDROID_KEYSTORE: keystore, ANDROID_STORE_PASSWORD: 'external-test', ANDROID_KEY_ALIAS: 'external-test', ANDROID_KEY_PASSWORD: 'external-test',
  } });
  assert.equal(result.ANDROID_KEYSTORE, keystore);
  assert.equal(result.ANDROID_KEY_ALIAS, 'external-test');
  assert.equal(result.NOETIC_ANDROID_CERTIFICATE_SHA256, undefined);
});

test('Android signing resolver loads a local profile and preserves its certificate pin', async t => {
  const { root, profile, saveProfile, createKeystorePlaceholder } = await fixture(t);
  await saveProfile();
  const keystore = await createKeystorePlaceholder();
  const result = await resolveAndroidSigningEnvironment({ root, env: { PUBLIC_BUILD_FLAG: '1' } });
  assert.equal(result.ANDROID_KEYSTORE, keystore);
  assert.equal(result.ANDROID_STORE_PASSWORD, profile.storePassword);
  assert.equal(result.ANDROID_KEY_PASSWORD, profile.keyPassword);
  assert.equal(result.ANDROID_KEY_ALIAS, profile.keyAlias);
  assert.equal(result.NOETIC_ANDROID_CERTIFICATE_SHA256, certificateSha256);
  assert.equal(result.PUBLIC_BUILD_FLAG, '1');
});

test('Android signing resolver rejects a missing local profile instead of falling back to unsigned', async t => {
  const { root, directory, createKeystorePlaceholder } = await fixture(t);
  await createKeystorePlaceholder();
  await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /目录存在但配置缺失/);
  assert.deepEqual(await readdir(directory), ['noetic-atlas-release.p12']);
});

test('Android signing resolver rejects malformed, null and incomplete local profiles', async t => {
  const { root, profileFile, profile, saveProfile } = await fixture(t);
  await saveProfile();
  await writeFile(profileFile, '{not JSON');
  await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /配置无法读取/);
  for (const invalid of [null, [], {}, { ...profile, schemaVersion: 2 }, { ...profile, certificateSha256: '' }, { ...profile, certificateSha256: 'z'.repeat(64) }]) {
    await saveProfile(invalid);
    await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /配置不完整/);
  }
  for (const name of ['storePassword', 'keyPassword', 'keyAlias']) {
    await saveProfile({ ...profile, [name]: ' ' });
    await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /配置不完整/);
  }
});

test('Android signing resolver rejects local profile key paths that escape the protected directory', async t => {
  const { root, profile, saveProfile } = await fixture(t);
  for (const keystore of ['../external.p12', '..\\external.jks', 'nested/key.p12', '/external.p12', 'key.txt']) {
    await saveProfile({ ...profile, keystore });
    await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /配置不完整/);
  }
});

test('Android signing resolver rejects missing key files for both local and explicit identities', async t => {
  const { root, saveProfile } = await fixture(t);
  await saveProfile();
  await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {} }), /密钥文件不存在/);
  await assert.rejects(resolveAndroidSigningEnvironment({ root, env: {
    ANDROID_KEYSTORE: 'missing.p12', ANDROID_STORE_PASSWORD: 'test', ANDROID_KEY_ALIAS: 'test', ANDROID_KEY_PASSWORD: 'test',
  } }), /密钥文件不存在/);
});

test('Android signing initialization never overwrites a surviving profile after partial setup', async t => {
  const { root, directory, profileFile, saveProfile } = await fixture(t);
  await saveProfile({ schemaVersion: 1, storePassword: 'synthetic-password-saved-before-key-generation' });
  const before = await readFile(profileFile);
  await assert.rejects(initializeAndroidSigning({ root, env: {}, javaRoot: '/never-run-keytool' }), /禁止覆盖/);
  assert.deepEqual(await readFile(profileFile), before);
  assert.deepEqual(await readdir(directory), ['signing.json']);
});

test('Android signing initialization never replaces a surviving key when its profile is missing', async t => {
  const { root, directory, createKeystorePlaceholder } = await fixture(t);
  const keystore = await createKeystorePlaceholder();
  const before = await readFile(keystore);
  await assert.rejects(initializeAndroidSigning({ root, env: {}, javaRoot: '/never-run-keytool' }), /禁止覆盖/);
  assert.deepEqual(await readFile(keystore), before);
  assert.deepEqual(await readdir(directory), ['noetic-atlas-release.p12']);
});

test('Android signing initialization refuses explicit credentials before any file or keytool operation', async t => {
  const { root } = await fixture(t);
  for (const variable of signatureVariables) {
    await assert.rejects(initializeAndroidSigning({ root, env: { [variable]: 'test-existing-signing-context' }, javaRoot: '/never-run-keytool' }), /已有签名配置/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('APK verifier parses real apksigner scheme labels and normalizes certificate digest case', () => {
  const result = parseApkSignerOutput(apkSignerOutput({ digest: certificateSha256.toUpperCase() }), certificateSha256);
  assert.equal(result.certificateSha256, certificateSha256);
  assert.deepEqual(result.schemes, { v1: false, v2: true, v3: true, v31: false, v4: false });
  const optional = parseApkSignerOutput(apkSignerOutput({ v1: true, v31: true, v4: true }).replaceAll('\n', '\r\n'), certificateSha256);
  assert.deepEqual(optional.schemes, { v1: true, v2: true, v3: true, v31: true, v4: true });
});

test('APK verifier rejects a different, missing or malformed certificate digest', () => {
  assert.throws(() => parseApkSignerOutput(apkSignerOutput({ digest: 'cd'.repeat(32) }), certificateSha256), /证书.*不一致/);
  assert.throws(() => parseApkSignerOutput(apkSignerOutput().replace(/^Signer #1 certificate SHA-256 digest:.*$/m, ''), certificateSha256), /证书.*不一致/);
  assert.throws(() => parseApkSignerOutput(apkSignerOutput({ digest: 'not-a-certificate-digest' }), certificateSha256), /证书.*不一致/);
  assert.throws(() => parseApkSignerOutput('', certificateSha256), /证书.*不一致/);
});

test('APK verifier rejects additional signers even when the expected certificate is present', () => {
  for (const digest of [certificateSha256, 'cd'.repeat(32)]) {
    const output = apkSignerOutput({ extraSigner: `Signer #2 certificate SHA-256 digest: ${digest}\n` });
    assert.throws(() => parseApkSignerOutput(output, certificateSha256), /证书.*不一致/);
  }
});

test('APK verifier requires v2 independently of v1, v3 and v3.1 verification', () => {
  assert.throws(() => parseApkSignerOutput(apkSignerOutput({ v1: true, v2: false, v3: true, v31: true }), certificateSha256), /缺少.*v2/);
  assert.throws(() => parseApkSignerOutput(apkSignerOutput().replace(/^Verified using v2.*\n/m, ''), certificateSha256), /缺少.*v2/);
});
