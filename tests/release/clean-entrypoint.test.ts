import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,cp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
// @ts-expect-error Release scripts intentionally use plain JavaScript.
import {parseReleaseArgs,createReleasePlan,selectReleaseTarget,executeRelease} from '../../scripts/release.mjs';

const project=resolve(import.meta.dirname,'../..');
async function fixture(t:test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'atlas-clean-entry-'));
  t.after(async()=>{
    const name=relative(resolve(tmpdir()),root);
    assert.ok(name.startsWith('atlas-clean-entry-')&&!isAbsolute(name)&&!name.startsWith('..'));
    await rm(root,{recursive:true,force:true});
  });
  async function put(name:string,contents:string) {await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),contents);}
  await put('package.json',JSON.stringify({name:'noetic-atlas',version:'1.0.0',type:'module'}));
  await put('artifacts/releases/runtime.zip','synthetic software');
  await put('artifacts/domain-packs/v1.0.0/questions.zip','synthetic content');
  await put('artifacts/domain-packs/v1.0.0/NOTICE.md','required attribution');
  await put('data/noetic-atlas.sqlite','synthetic current user data');
  await put('.localtools/signing/release/signing.json','synthetic signing profile');
  return {root,put};
}
async function assertCleaned(root:string) {
  await assert.rejects(readFile(join(root,'artifacts/releases/runtime.zip')),/ENOENT/);
  assert.equal(await readFile(join(root,'data/release-archives/domain-packs/v1.0.0/questions.zip'),'utf8'),'synthetic content');
  assert.equal(await readFile(join(root,'data/release-archives/domain-packs/v1.0.0/NOTICE.md'),'utf8'),'required attribution');
  assert.equal(await readFile(join(root,'data/noetic-atlas.sqlite'),'utf8'),'synthetic current user data');
  assert.equal(await readFile(join(root,'.localtools/signing/release/signing.json'),'utf8'),'synthetic signing profile');
  await assert.rejects(readFile(join(root,'artifacts/releases/release-report.json')),/ENOENT/);
}

test('clean accepts only cleanup options and its plan contains no checks or build commands',()=>{
  assert.equal(parseReleaseArgs(['CLEAN']).target,'clean');
  const preview=parseReleaseArgs(['clean','--dry-run']);
  const plan=createReleasePlan(preview);
  assert.equal(plan.length,1);assert.equal(plan[0].target,'clean');
  assert.deepEqual(plan[0].args,['scripts/release/cleanup.mjs','--dry-run']);
  for(const args of [['--skip-checks'],['--java-root','unused-jdk'],['--sdk-root','unused-sdk'],['--docker-command-only']]) {
    assert.throws(()=>parseReleaseArgs(['clean',...args]),/clean.*仅支持/);
  }
});

test('interactive selection offers clean and rejects build flags before cleanup',async()=>{
  for(const flags of [[],['--skip-checks'],['--java-root','unused'],['--sdk-root','unused'],['--docker-command-only']]) {
    const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',value=>text+=value.toString());
    const selected=selectReleaseTarget(parseReleaseArgs(flags),{input,output,isTTY:true});
    input.write('clean\n');
    if(flags.length)await assert.rejects(selected,/clean.*仅支持/);
    else assert.equal((await selected).target,'clean');
    assert.match(text,/source \/ clean/);input.end();output.end();
  }
});

test('clean execution archives before deleting and never requires Android or creates a new release report',async t=>{
  const {root}=await fixture(t);
  const result=await executeRelease(parseReleaseArgs(['clean']),{root,env:{}});
  assert.equal(result.exitCode,0);assert.equal(result.archived.length,1);assert.equal(result.removed.length,1);
  await assertCleaned(root);
});

test('clean dry-run reports actual files without archiving, deleting or bootstrapping dependencies',async t=>{
  const {root}=await fixture(t);
  const result=await executeRelease(parseReleaseArgs(['clean','--dry-run']),{root,env:{}});
  assert.equal(result.dryRun,true);assert.equal(result.removedBytes,Buffer.byteLength('synthetic software'));
  assert.equal(await readFile(join(root,'artifacts/releases/runtime.zip'),'utf8'),'synthetic software');
  await assert.rejects(readdir(join(root,'data/release-archives')),/ENOENT/);
  await assert.rejects(readdir(join(root,'node_modules')),/ENOENT/);
});

test('shell entrypoints run clean without node_modules or a lockfile and return invalid-option errors',async t=>{
  const entries=process.platform==='win32'
    ? [{binary:'cmd.exe',args:['/d','/c','release.cmd']},{binary:'powershell.exe',args:['-NoProfile','-ExecutionPolicy','Bypass','-File','release.ps1']}]
    : [{binary:'sh',args:['release.sh']}];
  for(const entry of entries) {
    const {root}=await fixture(t);
    await mkdir(join(root,'scripts/build'),{recursive:true});
    await copyFile(join(project,'scripts/release.mjs'),join(root,'scripts/release.mjs'));
    await cp(join(project,'scripts/release'),join(root,'scripts/release'),{recursive:true});
    await copyFile(join(project,'scripts/build/build-command.mjs'),join(root,'scripts/build/build-command.mjs'));
    for(const name of ['release.cmd','release.ps1','release.sh'])await copyFile(join(project,name),join(root,name));
    const preview=spawnSync(entry.binary,[...entry.args,'clean','--dry-run'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(preview.status,0,preview.stderr);assert.match(preview.stdout,/"dryRun": true/);
    assert.equal(await readFile(join(root,'artifacts/releases/runtime.zip'),'utf8'),'synthetic software');
    const result=spawnSync(entry.binary,[...entry.args,'clean'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,`${entry.binary}: ${result.stderr}`);assert.match(result.stdout,/"dryRun": false/);
    assert.doesNotMatch(result.stdout,/npm ci|npm-cli|npm run build/);
    await assert.rejects(readdir(join(root,'node_modules')),/ENOENT/);await assertCleaned(root);
    const invalid=spawnSync(entry.binary,[...entry.args,'clean','--skip-checks'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(invalid.status,1);assert.match(invalid.stderr,/clean.*仅支持/);
  }
});
