import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
// @ts-expect-error Release helpers use plain JavaScript.
import {collectSignedAndroidArtifact} from '../../scripts/release/android-artifact.mjs';
// @ts-expect-error Release helpers use plain JavaScript.
import {prepareGithubRelease} from '../../scripts/release/prepare-github.mjs';
// @ts-expect-error Release helpers use plain JavaScript.
import {executeRelease,parseReleaseArgs} from '../../scripts/release.mjs';

async function fixture(t:test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'atlas-release-apk-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const output=join(root,'artifacts/releases');await mkdir(output,{recursive:true});
  const bytes=Buffer.from('synthetic APK; real signature verification runs against the built APK during acceptance');
  await writeFile(join(root,'artifacts/noetic-atlas-release.apk'),bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const proof={apk:'noetic-atlas-release.apk',bytes:bytes.length,sha256,signed:true,signatureVerified:true,alignmentVerified:true,schemes:{v2:true},certificateSha256:'a'.repeat(64),certificate:{sha256:'a'.repeat(64)}};
  const save=()=>writeFile(join(root,'artifacts/android-signing-report.json'),JSON.stringify(proof));
  await save();return {root,output,bytes,proof,save};
}

test('release APK and its verification proof are versioned together and directly accepted as upload assets',async t=>{
  const {root,output,bytes,proof}=await fixture(t);
  const result=await collectSignedAndroidArtifact({root,output,version:'1.2.3'});
  assert.equal(result.artifact.file,'noetic-atlas-1.2.3-android.apk');
  assert.deepEqual(await readFile(join(output,result.artifact.file)),bytes);
  const copied=JSON.parse(await readFile(join(output,result.artifact.signingReport),'utf8'));
  assert.equal(copied.apk,result.artifact.file);assert.equal(copied.sha256,proof.sha256);
  await writeFile(join(root,'package.json'),JSON.stringify({name:'noetic-atlas',version:'1.2.3'}));
  await writeFile(join(output,'release-report.json'),JSON.stringify({project:'noetic-atlas',version:'1.2.3',checksSkipped:false,artifacts:[result.artifact],targets:[{target:'android',status:'built',signed:true,installable:true,artifacts:[result.artifact.file]}]}));
  const staged=await prepareGithubRelease({root});
  assert.equal(staged.androidSigning.certificateSha256,proof.certificateSha256);
  assert.equal(staged.files[0].file,result.artifact.file);
});

test('renamed or stale unsigned APKs cannot be collected using another verification result',async t=>{
  const {root,output,proof,save}=await fixture(t);
  proof.sha256='b'.repeat(64);await save();
  await assert.rejects(collectSignedAndroidArtifact({root,output,version:'1.0.0'}),/签名验证记录不匹配/);
  assert.deepEqual(await readdir(output),[]);
});

test('a release requiring Android fails before tests or software packages when formal signing is missing',async t=>{
  const root=await mkdtemp(join(tmpdir(),'atlas-no-signing-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'package.json'),JSON.stringify({name:'noetic-atlas',version:'1.0.0'}));
  await assert.rejects(executeRelease(parseReleaseArgs(['all']),{root,platform:'win32',env:{}}),/签名|密钥/);
  assert.deepEqual(await readdir(root),['package.json']);
});
