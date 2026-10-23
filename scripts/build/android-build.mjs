/** Cross-platform Android entry point; importing this module never starts a build. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { findNpmCli, formatCommand } from './build-command.mjs';
import { resolveAndroidSigningEnvironment, readSigningCertificate, verifySignedApk } from './android-signing.mjs';
import { resolveAndroidToolchain } from './android-toolchain.mjs';

export function parseAndroidArgs(args) {
  const options={mode:'Debug',javaRoot:null,sdkRoot:null,help:false};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--help'||arg==='-h') options.help=true;
    else if(['--mode','--java-root','--sdk-root'].includes(arg)) {
      const value=args[++i];
      if(!value||value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      if(arg==='--mode') {
        const mode=value.toLowerCase();
        if(!['debug','release'].includes(mode)) throw new Error('--mode 只能为 Debug 或 Release');
        options.mode=mode==='debug'?'Debug':'Release';
      } else options[arg==='--java-root'?'javaRoot':'sdkRoot']=value;
    } else throw new Error(`未知 Android 构建参数：${arg}`);
  }
  return options;
}

export function androidArtifactNames(mode,signed=false) {
  const suffix=mode==='Debug'?'debug':signed?'release':'release-unsigned';
  return {apk:`app-${suffix}.apk`,artifact:`noetic-atlas-${suffix}.apk`,directory:mode.toLowerCase()};
}

export function escapeJavaProperty(value) {
  return value.replace(/[\\:=#!\s\u0080-\uffff]/g,character=>{
    if(character.charCodeAt(0)>127) return `\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`;
    if(character==='\n') return '\\n';
    if(character==='\r') return '\\r';
    if(character==='\t') return '\\t';
    return `\\${character}`;
  });
}

export function createAndroidBuildPlan(options,{root=resolve(import.meta.dirname,'../..'),platform=process.platform,env=process.env,npmCli=null,hasDebugKey=false,hasLocalGradle=false}={}) {
  if(platform==='win32') return [{command:'powershell.exe',args:['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/build/android-debug.ps1'),'-Mode',options.mode,...(options.javaRoot?['-JavaRoot',resolve(root,options.javaRoot)]:[]),...(options.sdkRoot?['-SdkRoot',resolve(root,options.sdkRoot)]:[])],cwd:root}];
  if(!npmCli) throw new Error('Android 构建需要 npm CLI');
  const javaRoot=options.javaRoot||env.JAVA_HOME;
  if(!javaRoot) throw new Error('需要 Java 21，请设置 JAVA_HOME 或通过 --java-root 指定 JDK 路径');
  const steps=[];
  if(options.mode==='Debug'&&!hasDebugKey) steps.push({command:join(javaRoot,'bin/keytool'),args:['-genkeypair','-keystore',join(root,'.localtools/signing/debug.keystore'),'-alias','androiddebugkey','-storepass','android','-keypass','android','-dname','CN=Android Debug,O=Android,C=US','-keyalg','RSA','-keysize','2048','-validity','10000'],cwd:root});
  steps.push({command:process.execPath,args:[npmCli,'run','mobile:sync'],cwd:root});
  steps.push({command:hasLocalGradle?join(root,'.localtools/gradle-8.14.3/bin/gradle'):'sh',args:[...(hasLocalGradle?[]:['./gradlew']),'--no-daemon',':app:clean',`:app:assemble${options.mode}`],cwd:join(root,'android')});
  return steps;
}

function run(step,env) {
  console.log(`\n> ${formatCommand(step.command,step.args)}`);
  const result=spawnSync(step.command,step.args,{cwd:step.cwd,env,stdio:'inherit',shell:false});
  if(result.error) throw new Error(`${step.command} 无法执行：${result.error.message}`);
  if(result.status!==0) throw new Error(`Android 构建步骤退出码 ${result.status??'unknown'}：${step.command}`);
}

/** Fail before expensive release work; never initialize or replace a signing identity. */
export async function preflightAndroidRelease(options={}, {root=resolve(import.meta.dirname,'../..'),platform=process.platform,env=process.env}={}) {
  const signingEnv=await resolveAndroidSigningEnvironment({root,env});
  if(!signingEnv.ANDROID_KEYSTORE) throw new Error('正式 Android 发布必须配置签名：请恢复原有 .localtools/signing/release，或完整设置四项 ANDROID 签名环境变量；首次发布才运行 npm run android:signing:init');
  const toolchain=resolveAndroidToolchain(options,{root,env:signingEnv,platform});
  const certificate=readSigningCertificate({env:toolchain.env,javaRoot:toolchain.javaRoot});
  return {...toolchain,certificate};
}

export async function buildAndroid(options,{root=resolve(import.meta.dirname,'../..'),platform=process.platform,env=process.env}={}) {
  if(options.mode==='Release') {
    env=await resolveAndroidSigningEnvironment({root,env});
  }
  const toolchain=resolveAndroidToolchain(options,{root,env,platform});
  const {javaRoot,sdkRoot}=toolchain;
  env=toolchain.env;
  options={...options,javaRoot,sdkRoot};
  if(options.mode==='Release'&&env.ANDROID_KEYSTORE) readSigningCertificate({env,javaRoot});
  if(platform==='win32') {
    for(const step of createAndroidBuildPlan(options,{root,platform,env})) run(step,env);
    if(options.mode==='Release'&&env.ANDROID_KEYSTORE) console.log(JSON.stringify(await verifySignedApk({root,env,javaRoot:options.javaRoot,sdkRoot:options.sdkRoot}),null,2));
    return;
  }
  const buildEnv=env;
  await mkdir(join(root,'.localtools/signing'),{recursive:true});
  await writeFile(join(root,'android/local.properties'),`sdk.dir=${escapeJavaProperty(resolve(sdkRoot))}\n`);
  const steps=createAndroidBuildPlan({...options,javaRoot:resolve(javaRoot),sdkRoot:resolve(sdkRoot)},{root,platform,env:buildEnv,npmCli:findNpmCli({env}),hasDebugKey:existsSync(join(root,'.localtools/signing/debug.keystore')),hasLocalGradle:existsSync(join(root,'.localtools/gradle-8.14.3/bin/gradle'))});
  for(const step of steps) run(step,buildEnv);
  const names=androidArtifactNames(options.mode,Boolean(env.ANDROID_KEYSTORE));
  const source=join(root,'android/app/build/outputs/apk',names.directory,names.apk);
  for(const directory of ['dist/apk','artifacts']) {
    await mkdir(join(root,directory),{recursive:true});
    await copyFile(source,join(root,directory,names.artifact));
  }
  const artifact=join(root,'artifacts',names.artifact);
  console.log(JSON.stringify({path:artifact,sha256:createHash('sha256').update(await readFile(artifact)).digest('hex')},null,2));
  if(options.mode==='Release'&&env.ANDROID_KEYSTORE) console.log(JSON.stringify(await verifySignedApk({root,env,javaRoot:options.javaRoot,sdkRoot:options.sdkRoot}),null,2));
}

export async function main(args=process.argv.slice(2)) {
  const options=parseAndroidArgs(args);
  if(options.help) { console.log('用法：node scripts/build/android-build.mjs [--mode Debug|Release] [--java-root JDK路径] [--sdk-root SDK路径]\nWindows / Linux / macOS 需要 JDK 21、Android SDK API 36 和 build-tools 36.0.0。'); return; }
  await buildAndroid(options);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(`Android 构建终止：${error.message}`);process.exitCode=1;});
}
