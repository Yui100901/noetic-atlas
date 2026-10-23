import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// @ts-expect-error Build scripts intentionally have no declaration files.
import { parseAndroidArgs, createAndroidBuildPlan, androidArtifactNames, escapeJavaProperty, buildAndroid, preflightAndroidRelease } from '../../scripts/build/android-build.mjs';

test('Android Node entry validates modes and preserves paths containing spaces',()=>{
  assert.deepEqual(parseAndroidArgs(['--mode','release','--java-root','/opt/JDK 21','--sdk-root','/opt/Android SDK']),{mode:'Release',javaRoot:'/opt/JDK 21',sdkRoot:'/opt/Android SDK',help:false});
  assert.equal(parseAndroidArgs([]).mode,'Debug');
  assert.throws(()=>parseAndroidArgs(['--mode','Fast']),/Debug 或 Release/);
  assert.throws(()=>parseAndroidArgs(['--java-root']),/需要参数/);
  assert.throws(()=>parseAndroidArgs(['--unknown']),/未知/);
});

test('Linux Android uses native Java/npm/Gradle without a PowerShell dependency',()=>{
  const root=resolve('/project with spaces');
  const options=parseAndroidArgs(['--mode','Release','--java-root','/opt/JDK 21','--sdk-root','/opt/Android SDK']);
  const steps=createAndroidBuildPlan(options,{root,platform:'linux',env:{},npmCli:'/usr/share/nodejs/npm/bin/npm-cli.js'});
  assert.equal(steps.length,2);
  assert.deepEqual(steps[0].args,['/usr/share/nodejs/npm/bin/npm-cli.js','run','mobile:sync']);
  assert.equal(steps[1].command,'sh');
  assert.deepEqual(steps[1].args,['./gradlew','--no-daemon',':app:clean',':app:assembleRelease']);
  assert.ok(steps.every((step:any)=>!step.command.includes('powershell')&&!step.command.includes('pwsh')));
  const debug=createAndroidBuildPlan({...options,mode:'Debug'},{root,platform:'linux',env:{},npmCli:'/npm-cli.js'});
  assert.equal(debug[0].command,join('/opt/JDK 21','bin/keytool'));
  assert.ok(debug[0].args.includes('CN=Android Debug,O=Android,C=US'));
  assert.equal(createAndroidBuildPlan({...options,mode:'Debug'},{root,platform:'linux',env:{},npmCli:'/npm-cli.js',hasDebugKey:true}).length,2);
});

test('Windows Android retains the established PowerShell build with safe argument arrays',()=>{
  const options=parseAndroidArgs(['--mode','Release','--java-root','JDK with spaces','--sdk-root','SDK with spaces']);
  const plan=createAndroidBuildPlan(options,{root:resolve('.'),platform:'win32'});
  assert.equal(plan.length,1);
  assert.equal(plan[0].command,'powershell.exe');
  assert.deepEqual(plan[0].args.slice(-6),['-Mode','Release','-JavaRoot',resolve('JDK with spaces'),'-SdkRoot',resolve('SDK with spaces')]);
});

test('Android artifact naming keeps signed/unsigned and debug outputs distinct',()=>{
  assert.deepEqual(androidArtifactNames('Release'),{apk:'app-release-unsigned.apk',artifact:'noetic-atlas-release-unsigned.apk',directory:'release'});
  assert.equal(androidArtifactNames('Release',true).apk,'app-release.apk');
  assert.equal(androidArtifactNames('Debug',true).artifact,'noetic-atlas-debug.apk');
});

test('Java properties escape SDK whitespace, separators and Unicode for portable Gradle reads',()=>{
  assert.equal(escapeJavaProperty('/home/a b/安卓/sdk'),'/home/a\\ b/\\u5b89\\u5353/sdk');
  assert.equal(escapeJavaProperty('C:\\Android SDK'),'C\\:\\\\Android\\ SDK');
});

test('Linux Android fails early with a clear JDK requirement before build commands',async()=>{
  await assert.rejects(buildAndroid(parseAndroidArgs([]),{platform:'linux',env:{}}),/需要 Java 21/);
  await assert.rejects(buildAndroid(parseAndroidArgs(['--java-root','/missing/noetic-jdk-21']),{platform:'linux',env:{}}),/需要 Java 21/);
});

test('unified Android release requires an existing identity before examining the toolchain',async t=>{
  const temporaryRoot=resolve(tmpdir());
  const root=await mkdtemp(join(temporaryRoot,'atlas-android-preflight-'));
  t.after(async()=>{
    const insideTemporaryRoot=relative(temporaryRoot,resolve(root));
    assert.ok(insideTemporaryRoot.startsWith('atlas-android-preflight-')&&!insideTemporaryRoot.startsWith('..')&&!isAbsolute(insideTemporaryRoot));
    await rm(root,{recursive:true,force:true});
  });
  await assert.rejects(preflightAndroidRelease({javaRoot:'/never-run-java'},{root,env:{}}),/正式 Android 发布必须配置签名/);
  assert.deepEqual(await readdir(root),[],'preflight must not initialize a replacement key or create build output');
  await assert.rejects(preflightAndroidRelease({},{root,env:{ANDROID_KEY_ALIAS:'partial-existing-key'}}),/完整设置四项/);
});
