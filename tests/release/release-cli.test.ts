import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
// Build scripts remain plain JS so release users do not need a TS runtime.
// @ts-expect-error Build scripts intentionally have no declaration files.
import { parseReleaseArgs, createReleasePlan, selectReleaseTarget, selectedTargets, commandAvailable, executeRelease, findNpmCli } from '../../scripts/release.mjs';
// @ts-expect-error Build scripts intentionally have no declaration files.
import { collectReleaseFiles } from '../../scripts/release/release-web.mjs';

const root=resolve(import.meta.dirname,'../..');
const release=resolve(root,'scripts/release.mjs');

test('release accepts documented targets and rejects ambiguous or unknown arguments',()=>{
  for(const target of ['all','windows','web','android','docker','source']) assert.equal(parseReleaseArgs([target]).target,target);
  assert.equal(parseReleaseArgs(['WINDOWS','--skip-checks']).skipChecks,true);
  assert.throws(()=>parseReleaseArgs(['web','windows']),/只能选择一个/);
  assert.throws(()=>parseReleaseArgs(['mobile']),/未知参数/);
  assert.throws(()=>parseReleaseArgs(['web','--java-root']),/路径参数/);
  assert.throws(()=>parseReleaseArgs(['windows','--docker-command-only']),/仅适用于/);
});

test('all runs one shared build and invokes portable Windows and Android release packaging',()=>{
  const plan=createReleasePlan(parseReleaseArgs(['all','--java-root','JDK 21','--sdk-root','Android SDK']),{version:'2.3.4',node:'node',platform:'win32'});
  assert.equal(plan.filter((s:any)=>s.target==='checks'&&s.args.join(' ')==='run build').length,1);
  assert.equal(plan.filter((s:any)=>s.target==='checks'&&s.args.join(' ')==='test').length,1);
  assert.deepEqual(selectedTargets('all'),['web','windows','android','docker']);
  assert.deepEqual(plan.find((s:any)=>s.target==='windows').args,['scripts/release/release-windows.mjs','--reuse-build']);
  assert.deepEqual(plan.find((s:any)=>s.target==='android').args,['scripts/build/android-build.mjs','--mode','Release','--java-root','JDK 21','--sdk-root','Android SDK']);
  assert.deepEqual(plan.find((s:any)=>s.target==='docker').args,['build','-t','noetic-atlas:2.3.4','.']);
});

test('--skip-checks still builds and validates public data and documentation',()=>{
  const commands=createReleasePlan(parseReleaseArgs(['web','--skip-checks'])).filter((s:any)=>s.target==='checks').map((s:any)=>s.args.join(' '));
  assert.deepEqual(commands,['run build','run data:validate','run docs:check']);
});

test('a missing noninteractive target is an explicit error with actionable command',async()=>{
  await assert.rejects(selectReleaseTarget(parseReleaseArgs([]),{isTTY:false}),/请指定发布目标/);
  const result=spawnSync(process.execPath,[release],{cwd:root,encoding:'utf8',input:''});
  assert.equal(result.status,1);
  assert.match(result.stderr,/--help/);
});

test('interactive release target selection reads one target and closes cleanly',async()=>{
  const input=new PassThrough(); const output=new PassThrough();
  const promise=selectReleaseTarget(parseReleaseArgs([]),{input,output,isTTY:true});
  input.write('windows\n');
  assert.equal((await promise).target,'windows');
  input.end(); output.end();
});

test('dry-run prints all commands without invoking npm, Android, Windows or Docker builds',()=>{
  const result=spawnSync(process.execPath,[release,'all','--dry-run','--docker-command-only'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:''}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/npm run build/);
  if(process.platform==='win32') assert.match(result.stdout,/release-windows\.mjs.*--reuse-build/);
  else assert.match(result.stdout,/windows.*待构建/);
  assert.match(result.stdout,/android-build\.mjs/);
  assert.match(result.stdout,/docker build -t noetic-atlas:/);
  assert.match(result.stdout,/仅打印，不执行/);
  assert.doesNotMatch(result.stdout,/发布失败/);
});

test('Linux all keeps web, native Android and Docker while marking Windows as pending',()=>{
  const plan=createReleasePlan(parseReleaseArgs(['all','--java-root','/opt/JDK 21','--sdk-root','/opt/Android SDK']),{platform:'linux',node:'/usr/bin/node'});
  const windows=plan.find((step:any)=>step.target==='windows');
  assert.equal(windows.unsupported,true);
  assert.match(windows.buildCommand,/release\.cmd windows/);
  const android=plan.find((step:any)=>step.target==='android');
  assert.equal(android.command,'/usr/bin/node');
  assert.deepEqual(android.args,['scripts/build/android-build.mjs','--mode','Release','--java-root','/opt/JDK 21','--sdk-root','/opt/Android SDK']);
  assert.ok(plan.some((step:any)=>step.target==='web'));
  assert.ok(plan.some((step:any)=>step.target==='docker'));
  assert.ok(!plan.some((step:any)=>/powershell|pwsh/i.test(step.command)));
});

test('unsupported standalone Windows does not run builds and reports pending with exit 2',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'noetic-unsupported-release-'));
  try {
    await writeFile(join(directory,'package.json'),JSON.stringify({name:'noetic-atlas',version:'1.0.0'}));
    const options=parseReleaseArgs(['windows']);
    assert.equal(createReleasePlan(options,{platform:'linux'}).filter((step:any)=>step.target==='checks').length,0);
    const result=await executeRelease(options,{root:directory,platform:'linux'});
    assert.equal(result.exitCode,2);
    assert.equal(result.targets[0].status,'pending');
    assert.deepEqual(result.artifacts,[]);
    const report=JSON.parse(await readFile(join(directory,'artifacts/releases/release-report.json'),'utf8'));
    assert.equal(report.targets[0].status,'pending');
    assert.match(report.targets[0].command,/release\.cmd windows/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('npm CLI can be resolved without npm-run using a Node installation path with spaces',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'noetic npm '));
  try {
    const npmCli=join(directory,'lib/node_modules/npm/bin/npm-cli.js');
    await mkdir(join(directory,'lib/node_modules/npm/bin'),{recursive:true});
    await writeFile(npmCli,'// npm CLI fixture');
    assert.equal(findNpmCli({env:{PATH:''},node:join(directory,'bin/node'),platform:'linux'}),npmCli);
    assert.throws(()=>findNpmCli({env:{PATH:''},node:join(directory,'missing/deep/node'),platform:'linux'}),/无法定位 npm/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('Docker command-only plan does not contain local builds and command discovery never launches Docker',()=>{
  const plan=createReleasePlan(parseReleaseArgs(['docker','--docker-command-only']));
  assert.equal(plan.length,1);
  assert.equal(plan[0].command,'docker');
  assert.equal(commandAvailable('docker',{path:''}),false);
});

test('OS release entrypoints preserve spaced parameters and return the shared CLI exit status',()=>{
  const args=['all','--dry-run','--java-root','JDK 21 folder','--sdk-root','Android SDK folder'];
  const entrypoints=process.platform==='win32'
    ? [{command:'powershell.exe',args:['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(root,'release.ps1')]},{command:'cmd.exe',args:['/d','/c','release.cmd']}]
    : [{command:'sh',args:[resolve(root,'release.sh')]}];
  for(const entrypoint of entrypoints) {
    const result=spawnSync(entrypoint.command,[...entrypoint.args,...args],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,`${entrypoint.command}: ${result.stderr}`);
    assert.match(result.stdout,/--java-root "JDK 21 folder" --sdk-root "Android SDK folder"/);
    const failure=spawnSync(entrypoint.command,[...entrypoint.args,'invalid-target'],{cwd:root,encoding:'utf8'});
    assert.equal(failure.status,1,`${entrypoint.command}: ${failure.stderr}`);
    assert.match(failure.stderr,/未知参数/);
  }
});

test('source allowlist collector excludes generated release staging, DBs and local signing settings',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'noetic-release-'));
  try {
    await mkdir(join(directory,'desktop','release-staging'),{recursive:true});
    await writeFile(join(directory,'desktop','main.mjs'),'export {};');
    await writeFile(join(directory,'desktop','release-staging','private.txt'),'ignored');
    await writeFile(join(directory,'desktop','local.properties'),'ignored');
    await writeFile(join(directory,'desktop','private.sqlite'),'ignored');
    assert.deepEqual((await collectReleaseFiles(directory,['desktop'])).map((f:any)=>f.name),['desktop/main.mjs']);
  } finally {await rm(directory,{recursive:true,force:true});}
});
