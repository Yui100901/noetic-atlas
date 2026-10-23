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
  const root=await mkdtemp(join(tmpdir(),'atlas-github-release-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'artifacts/releases'),{recursive:true});
  await mkdir(join(root,'data'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({name:'noetic-atlas',version:'1.0.0'}));
  await writeFile(join(root,'data/seed.json'),'ignored private data');
  const file='noetic-atlas-1.0.0-runtime.zip',bytes=createZip([
    {name:'config/defaults.json',data:await readFile('config/defaults.json')},
    {name:'release-manifest.json',data:Buffer.from(JSON.stringify({counts:{questions:0,domains:0,categories:0,tags:0},dataBoundary:SOFTWARE_DATA_BOUNDARY}))},
  ],'noetic-atlas-1.0.0');
  await writeFile(join(root,'artifacts/releases',file),bytes);
  const report={project:'noetic-atlas',version:'1.0.0',checksSkipped:false,targets:[{target:'web',status:'built',artifacts:[file]}],artifacts:[{file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  const save=()=>writeFile(join(root,'artifacts/releases/release-report.json'),JSON.stringify(report));
  await save();return {root,report,save};
}

test('GitHub upload staging includes only verified software and never copies local data or optional content',async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,'data/private-configuration.json'),'private');
  await writeFile(join(root,'artifacts/releases/noetic-atlas-1.0.0-content.zip'),'optional content');
  const result=await prepareGithubRelease({root});
  assert.equal(result.softwareOnly,true);assert.equal(result.expandedContentIncluded,false);
  assert.deepEqual((await readdir(result.output)).sort(),['RELEASE-NOTES.md','SHA256SUMS.txt','noetic-atlas-1.0.0-runtime.zip','release-files.json']);
  assert.equal(result.initialData.questions,0);
  assert.match(await readFile(join(result.output,'RELEASE-NOTES.md'),'utf8'),/密钥不会进入配置 JSON/);
  await assert.rejects(()=>prepareGithubRelease({root}),/已存在/);
});

test('staging rejects stale reports, tampered binaries, skipped checks and failed targets before creating output',async t=>{
  const {root,report,save}=await fixture(t);
  report.version='0.9.0';await save();await assert.rejects(()=>prepareGithubRelease({root}),/版本/);
  report.version='1.0.0';report.checksSkipped=true;await save();await assert.rejects(()=>prepareGithubRelease({root}),/跳过/);
  report.checksSkipped=false;report.targets[0].status='failed';await save();await assert.rejects(()=>prepareGithubRelease({root}),/失败/);
  report.targets[0].status='built';await save();
  await writeFile(join(root,'artifacts/releases',report.artifacts[0].file),'tampered');
  await assert.rejects(()=>prepareGithubRelease({root}),/摘要/);
  assert.ok(!(await readdir(join(root,'artifacts'))).includes('github'));
});

test('staging excludes unsigned/debug APKs and rejects unrecorded or arbitrary publication assets',async t=>{
  const {root,report,save}=await fixture(t);
  const unsigned={file:'../noetic-atlas-release-unsigned.apk',bytes:0,sha256:'0'.repeat(64)};
  report.artifacts.push(unsigned);await save();
  const result=await prepareGithubRelease({root});assert.deepEqual(result.excluded,['noetic-atlas-release-unsigned.apk']);
  report.artifacts[1]={...unsigned,file:'private-configuration.json'};await save();
  await assert.rejects(()=>prepareGithubRelease({root,output:join(root,'artifacts/rejected')}),/非软件/);
  report.artifacts.pop();report.targets[0].artifacts=[];await save();
  await assert.rejects(()=>prepareGithubRelease({root,output:join(root,'artifacts/rejected')}),/本次成功构建/);
  await assert.rejects(()=>prepareGithubRelease({root,output:join(root,'outside')}),/artifacts/);
});

test('staging rejects a validly hashed legacy software ZIP that still embeds question data',async t=>{
  const {root,report,save}=await fixture(t);
  const bytes=createZip([
    {name:'config/defaults.json',data:await readFile('config/defaults.json')},
    {name:'data/seed.json',data:Buffer.from('{"questions":[{"id":"old"}]}')},
    {name:'release-manifest.json',data:Buffer.from(JSON.stringify({counts:{questions:1,domains:0,categories:0,tags:0},dataBoundary:SOFTWARE_DATA_BOUNDARY}))},
  ],'noetic-atlas-1.0.0');
  await writeFile(join(root,'artifacts/releases',report.artifacts[0].file),bytes);
  report.artifacts[0].bytes=bytes.length;report.artifacts[0].sha256=createHash('sha256').update(bytes).digest('hex');await save();
  await assert.rejects(()=>prepareGithubRelease({root}),/题库或工作数据/);
});
