import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import { prepareGithubRelease } from '../../scripts/release/prepare-github.mjs';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import { createZip, SOFTWARE_DATA_BOUNDARY } from '../../scripts/release/release-web.mjs';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-github-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'artifacts/releases'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'noetic-atlas', version: '1.0.0' }),
  );
  await writeFile(join(root, 'data/seed.json'), 'ignored private data');
  const file = 'noetic-atlas-1.0.0-runtime.zip',
    bytes = createZip(
      [
        { name: 'config/defaults.json', data: await readFile('config/defaults.json') },
        {
          name: 'release-manifest.json',
          data: Buffer.from(
            JSON.stringify({
              counts: { questions: 0, domains: 0, categories: 0, tags: 0 },
              dataBoundary: SOFTWARE_DATA_BOUNDARY,
            }),
          ),
        },
      ],
      'noetic-atlas-1.0.0',
    );
  await writeFile(join(root, 'artifacts/releases', file), bytes);
  const report = {
    project: 'noetic-atlas',
    version: '1.0.0',
    checksSkipped: false,
    targets: [{ target: 'web', status: 'built', artifacts: [file] }],
    artifacts: [
      { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    ],
  };
  const save = () =>
    writeFile(join(root, 'artifacts/releases/release-report.json'), JSON.stringify(report));
  await save();
  return { root, report, save };
}

test('GitHub upload staging includes only verified software and never copies local data or optional content', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'data/private-configuration.json'), 'private');
  await writeFile(
    join(root, 'artifacts/releases/noetic-atlas-1.0.0-content.zip'),
    'optional content',
  );
  const result = await prepareGithubRelease({ root });
  assert.equal(result.softwareOnly, true);
  assert.equal(result.expandedContentIncluded, false);
  assert.deepEqual((await readdir(result.output)).sort(), [
    'RELEASE-NOTES.md',
    'SHA256SUMS.txt',
    'noetic-atlas-1.0.0-runtime.zip',
    'release-files.json',
  ]);
  assert.equal(result.initialData.questions, 0);
  assert.match(
    await readFile(join(result.output, 'RELEASE-NOTES.md'), 'utf8'),
    /密钥不会进入配置 JSON/,
  );
  await assert.rejects(() => prepareGithubRelease({ root }), /已存在/);
});

test('upload notes include the matching version changelog when supplied', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/版本说明-1.0.0.md'), '# 认知星图 1.0.0\n\n专项更新说明。\n');
  const result = await prepareGithubRelease({ root });
  const notes = await readFile(join(result.output, 'RELEASE-NOTES.md'), 'utf8');
  assert.match(notes, /## 本次更新\n\n专项更新说明。/);
  assert.equal(notes.match(/# 认知星图 1\.0\.0/g)?.length, 1);
});

test('staging rejects stale reports, tampered binaries, skipped checks and failed targets before creating output', async (t) => {
  const { root, report, save } = await fixture(t);
  report.version = '0.9.0';
  await save();
  await assert.rejects(() => prepareGithubRelease({ root }), /版本/);
  report.version = '1.0.0';
  report.checksSkipped = true;
  await save();
  await assert.rejects(() => prepareGithubRelease({ root }), /跳过/);
  report.checksSkipped = false;
  report.targets[0].status = 'failed';
  await save();
  await assert.rejects(() => prepareGithubRelease({ root }), /失败/);
  report.targets[0].status = 'built';
  await save();
  await writeFile(join(root, 'artifacts/releases', report.artifacts[0].file), 'tampered');
  await assert.rejects(() => prepareGithubRelease({ root }), /摘要/);
  assert.ok(!(await readdir(join(root, 'artifacts'))).includes('github'));
});

test('staging excludes unsigned/debug APKs and rejects unrecorded or arbitrary publication assets', async (t) => {
  const { root, report, save } = await fixture(t);
  const unsigned = {
    file: '../noetic-atlas-release-unsigned.apk',
    bytes: 0,
    sha256: '0'.repeat(64),
  };
  report.artifacts.push(unsigned);
  await save();
  const result = await prepareGithubRelease({ root });
  assert.deepEqual(result.excluded, ['noetic-atlas-release-unsigned.apk']);
  report.artifacts[1] = { ...unsigned, file: 'private-configuration.json' };
  await save();
  await assert.rejects(
    () => prepareGithubRelease({ root, output: join(root, 'artifacts/rejected') }),
    /非软件/,
  );
  report.artifacts.pop();
  report.targets[0].artifacts = [];
  await save();
  await assert.rejects(
    () => prepareGithubRelease({ root, output: join(root, 'artifacts/rejected') }),
    /本次成功构建/,
  );
  await assert.rejects(
    () => prepareGithubRelease({ root, output: join(root, 'outside') }),
    /artifacts/,
  );
});

test('staging rejects a validly hashed legacy software ZIP that still embeds question data', async (t) => {
  const { root, report, save } = await fixture(t);
  const bytes = createZip(
    [
      { name: 'config/defaults.json', data: await readFile('config/defaults.json') },
      { name: 'data/seed.json', data: Buffer.from('{"questions":[{"id":"old"}]}') },
      {
        name: 'release-manifest.json',
        data: Buffer.from(
          JSON.stringify({
            counts: { questions: 1, domains: 0, categories: 0, tags: 0 },
            dataBoundary: SOFTWARE_DATA_BOUNDARY,
          }),
        ),
      },
    ],
    'noetic-atlas-1.0.0',
  );
  await writeFile(join(root, 'artifacts/releases', report.artifacts[0].file), bytes);
  report.artifacts[0].bytes = bytes.length;
  report.artifacts[0].sha256 = createHash('sha256').update(bytes).digest('hex');
  await save();
  await assert.rejects(() => prepareGithubRelease({ root }), /题库或工作数据/);
});

test('staging requires a signature verification bound to the exact release APK and publishes only public certificate metadata', async (t) => {
  const { root, report, save } = await fixture(t);
  const bytes = Buffer.from(
    'isolated APK fixture; signature tools are exercised by the real Android build',
  );
  const artifact = {
    file: '../noetic-atlas-release.apk',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await writeFile(join(root, 'artifacts/noetic-atlas-release.apk'), bytes);
  report.artifacts.push(artifact);
  report.targets.push({
    target: 'android',
    status: 'built',
    artifacts: [artifact.file],
    signed: true,
    installable: true,
  } as (typeof report.targets)[number]);
  await save();
  await assert.rejects(() => prepareGithubRelease({ root }), /缺少签名验证报告/);
  const proof = {
    apk: 'noetic-atlas-release.apk',
    ...artifact,
    signed: true,
    signatureVerified: true,
    alignmentVerified: true,
    schemes: { v2: true, v3: true },
    certificateSha256: 'a'.repeat(64),
    certificate: { sha256: 'a'.repeat(64) },
    privateField: 'never copy this',
  };
  const saveProof = () =>
    writeFile(join(root, 'artifacts/android-signing-report.json'), JSON.stringify(proof));
  proof.sha256 = 'b'.repeat(64);
  await saveProof();
  await assert.rejects(() => prepareGithubRelease({ root }), /签名验证记录不匹配/);
  proof.sha256 = artifact.sha256;
  proof.schemes.v2 = false;
  await saveProof();
  await assert.rejects(() => prepareGithubRelease({ root }), /签名验证记录不匹配/);
  proof.schemes.v2 = true;
  await saveProof();
  const result = await prepareGithubRelease({ root });
  assert.equal(result.androidSigning.certificateSha256, 'a'.repeat(64));
  assert.equal(result.androidSigning.file, 'noetic-atlas-1.0.0-android.apk');
  const output = await readFile(join(result.output, 'release-files.json'), 'utf8');
  assert.doesNotMatch(output, /privateField|never copy this/);
  assert.ok((await readdir(result.output)).includes('noetic-atlas-1.0.0-android.apk'));
});

test('staging rejects relocated signing credentials even in a validly hashed empty-install ZIP', async (t) => {
  const { root, report, save } = await fixture(t);
  for (const name of [
    'android/signing.json',
    'android/release.p12',
    '.localtools/signing/release/BACKUP.txt',
  ]) {
    const bytes = createZip(
      [
        { name: 'config/defaults.json', data: await readFile('config/defaults.json') },
        {
          name: 'release-manifest.json',
          data: Buffer.from(
            JSON.stringify({
              counts: { questions: 0, domains: 0, categories: 0, tags: 0 },
              dataBoundary: SOFTWARE_DATA_BOUNDARY,
            }),
          ),
        },
        { name, data: Buffer.from('synthetic credential fixture') },
      ],
      'noetic-atlas-1.0.0',
    );
    await writeFile(join(root, 'artifacts/releases', report.artifacts[0].file), bytes);
    report.artifacts[0].bytes = bytes.length;
    report.artifacts[0].sha256 = createHash('sha256').update(bytes).digest('hex');
    await save();
    await assert.rejects(() => prepareGithubRelease({ root }), /私有签名文件/);
  }
});
