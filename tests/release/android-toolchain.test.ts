import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
// @ts-expect-error Build helpers intentionally have no declaration files.
import { resolveAndroidToolchain } from '../../scripts/build/android-toolchain.mjs';

function fixture(platform='linux') {
  const root=resolve('synthetic android project');
  const javaRoot=join(root,'tools','JDK 21');
  const sdkRoot=join(root,'tools','Android SDK');
  const suffix=platform==='win32'?'.exe':'';
  const files=new Set<string>();
  const links=new Map<string,string>();
  const calls:{command:string,args:string[]}[]=[];
  const addJava=(directory=javaRoot)=>{for(const name of ['java','javac','keytool']) files.add(join(directory,`bin/${name}${suffix}`));};
  const addSdk=(directory=sdkRoot)=>{for(const file of ['platforms/android-36/android.jar',`build-tools/36.0.0/aapt2${suffix}`,`build-tools/36.0.0/zipalign${suffix}`,'build-tools/36.0.0/lib/apksigner.jar']) files.add(join(directory,file));};
  addJava(); addSdk();
  const response={status:0,stdout:'',stderr:`Property settings:\n    java.home = ${javaRoot}\n    java.specification.version = 21\nopenjdk version "21.0.8"\n`};
  const dependencies={
    root,platform,home:join(root,'home'),env:{},
    exists:(path:string)=>files.has(path),realpath:(path:string)=>links.get(path)||path,
    execute:(command:string,args:string[])=>{calls.push({command,args});return response;},
  };
  return {root,javaRoot,sdkRoot,suffix,files,links,calls,response,dependencies,addJava,addSdk};
}

test('Android toolchain resolves relative explicit paths once and passes one absolute environment to every build step',()=>{
  const f=fixture();
  const input=Object.freeze({PATH:'other-bin',PUBLIC_FLAG:'keep',JAVA_HOME:'ignored-jdk',ANDROID_HOME:'ignored-sdk'});
  const output=resolveAndroidToolchain({javaRoot:'tools/JDK 21',sdkRoot:'tools/Android SDK'},{...f.dependencies,env:input});
  assert.equal(output.javaRoot,f.javaRoot);
  assert.equal(output.sdkRoot,f.sdkRoot);
  assert.equal(output.env.JAVA_HOME,f.javaRoot);
  assert.equal(output.env.ANDROID_HOME,f.sdkRoot);
  assert.equal(output.env.ANDROID_SDK_ROOT,f.sdkRoot);
  assert.equal(output.env.PATH,`${join(f.javaRoot,'bin')}:other-bin`);
  assert.equal(output.env.GRADLE_USER_HOME,join(f.root,'.localtools/gradle-home'));
  assert.equal(output.env.PUBLIC_FLAG,'keep');
  assert.equal(input.JAVA_HOME,'ignored-jdk');
  assert.deepEqual(f.calls[0].args,['-XshowSettings:properties','-version']);
});

test('Android toolchain discovers JAVA_HOME and ANDROID_SDK_ROOT without command-line arguments',()=>{
  const f=fixture();
  const output=resolveAndroidToolchain({},{...f.dependencies,env:{JAVA_HOME:f.javaRoot,ANDROID_SDK_ROOT:f.sdkRoot}});
  assert.equal(output.javaRoot,f.javaRoot);
  assert.equal(output.sdkRoot,f.sdkRoot);
});

test('Android toolchain resolves PATH Java symlinks and the runtime-reported home instead of assuming JAVA_HOME exists',()=>{
  const f=fixture();
  const pathJava=join(f.root,'launcher-bin',`java${f.suffix}`),realJava=join(f.root,'real launcher',`java${f.suffix}`);
  f.files.add(pathJava);f.links.set(pathJava,realJava);
  const output=resolveAndroidToolchain({sdkRoot:f.sdkRoot},{...f.dependencies,env:{PATH:join(f.root,'launcher-bin')}});
  assert.equal(f.calls[0].command,realJava);
  assert.equal(output.javaRoot,f.javaRoot,'reported home can differ from the launcher location');
});

test('Windows toolchain handles quoted PATH entries and case-insensitive Path while normalizing the child PATH',()=>{
  const f=fixture('win32');
  const input=Object.freeze({Path:`"${join(f.javaRoot,'bin')}";other-bin`,ANDROID_HOME:f.sdkRoot});
  const output=resolveAndroidToolchain({},{...f.dependencies,env:input});
  assert.equal(output.javaRoot,f.javaRoot);
  assert.equal(output.env.PATH,`${join(f.javaRoot,'bin')};${input.Path}`);
  assert.equal(output.env.Path,undefined);
  assert.ok(f.calls[0].command.endsWith('java.exe'));
});

test('Android toolchain checks local SDK and platform-standard user SDK locations only when no SDK was selected',()=>{
  for(const location of ['local','linux','mac','windows']) {
    const f=fixture();
    const target=location==='local'?join(f.root,'.localtools/android-sdk'):location==='linux'?join(f.dependencies.home,'Android/Sdk'):location==='mac'?join(f.dependencies.home,'Library/Android/sdk'):join(f.root,'AppData/Local/Android/Sdk');
    f.addSdk(target);
    const output=resolveAndroidToolchain({javaRoot:f.javaRoot},{...f.dependencies,env:{LOCALAPPDATA:join(f.root,'AppData/Local')}});
    assert.equal(output.sdkRoot,target);
  }
});

test('Android toolchain never falls back from an invalid explicit Java or SDK installation',()=>{
  const f=fixture();
  const env={JAVA_HOME:f.javaRoot,ANDROID_HOME:f.sdkRoot,PATH:join(f.javaRoot,'bin')};
  f.addSdk(join(f.root,'.localtools/android-sdk'));
  assert.throws(()=>resolveAndroidToolchain({javaRoot:'missing-jdk'},{...f.dependencies,env}),/需要 Java 21/);
  assert.throws(()=>resolveAndroidToolchain({sdkRoot:'missing-sdk'},{...f.dependencies,env}),/完整 build-tools/);
  assert.throws(()=>resolveAndroidToolchain({},{...f.dependencies,env:{...env,ANDROID_HOME:'stale-sdk',ANDROID_SDK_ROOT:f.sdkRoot}}),/完整 build-tools/);
});

test('Android toolchain fails early for missing Java, a JRE, an incompatible JDK or a failed launcher',()=>{
  for(const invalid of ['missing','jre','old','future','failed','unlaunchable']) {
    const f=fixture();
    if(invalid==='missing') f.files.delete(join(f.javaRoot,'bin/java'));
    if(invalid==='jre') f.files.delete(join(f.javaRoot,'bin/javac'));
    if(invalid==='old'||invalid==='future') f.response.stderr=`java.specification.version = ${invalid==='old'?17:25}\nopenjdk version "${invalid==='old'?17:25}.0.1"`;
    if(invalid==='failed') f.response.status=1;
    if(invalid==='unlaunchable') f.dependencies.execute=()=>({status:null,stdout:'',stderr:'',error:new Error('tool failed')}) as any;
    assert.throws(()=>resolveAndroidToolchain({javaRoot:f.javaRoot,sdkRoot:f.sdkRoot},f.dependencies),/需要 Java 21/);
  }
});

test('Android toolchain rejects incomplete SDKs before Gradle runs',()=>{
  for(const file of ['platforms/android-36/android.jar','build-tools/36.0.0/aapt2','build-tools/36.0.0/zipalign','build-tools/36.0.0/lib/apksigner.jar']) {
    const f=fixture();f.files.delete(join(f.sdkRoot,file));
    assert.throws(()=>resolveAndroidToolchain({javaRoot:f.javaRoot,sdkRoot:f.sdkRoot},f.dependencies),/API 36.*完整 build-tools/);
  }
});

test('Android toolchain continues PATH discovery after an incompatible Java and supports standard version-only output',()=>{
  const f=fixture();
  const first=join(f.root,'jdk17/bin/java');f.files.add(first);
  const execute=(command:string,args:string[])=>command===first?{status:0,stdout:'',stderr:'openjdk version "17.0.12"'}:{status:0,stdout:'openjdk 21.0.8 2025-07-15',stderr:''};
  const output=resolveAndroidToolchain({sdkRoot:f.sdkRoot},{...f.dependencies,execute,env:{PATH:`${join(f.root,'jdk17/bin')}:${join(f.javaRoot,'bin')}`}});
  assert.equal(output.javaRoot,f.javaRoot);
});
