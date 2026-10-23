/** One release entry point. Importing this module never runs a build. */
import { existsSync, accessSync, constants, realpathSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { packageWebRelease } from './release/release-web.mjs';

export const RELEASE_TARGETS = ['all','windows','web','android','docker','source'];
export const HELP = `认知星图一键发布

用法：npm run release -- [all|windows|web|android|docker|source] [选项]
      双击 release.cmd 后输入目标，也可执行 release.cmd windows
      PowerShell：.\\release.ps1 web；Linux / macOS：./release.sh web

  all       Web 源码/运行包 + Windows 便携版 + Android 正式构建 + Docker 镜像
  windows   Windows x64 便携版 ZIP，解压后双击启动
  web       Web 源码和运行包 ZIP
  android   Android Release APK（配置签名环境变量后生成签名 APK）
  docker    执行 docker build -t noetic-atlas:<版本> .
  source    仅源码 ZIP

  --skip-checks          跳过自动化测试；仍构建并校验公开数据和文档
  --dry-run              仅显示计划，不执行命令、不生成文件
  --docker-command-only  只打印 Docker 构建命令，不调用 Docker
  --java-root <路径>     Android 构建使用的 Java 21 路径（或 JAVA_HOME）
  --sdk-root <路径>      Android SDK 路径（或 ANDROID_HOME）
  --help                显示帮助

all 在未安装 Docker 时会继续生成其他包，并明确将 Docker 标记为待构建。
Windows 便携版必须在 Windows 构建；其他系统执行 all 时会将其标记为待构建。
单独 docker 且未安装 Docker 时退出码为 2；--docker-command-only 退出码为 0。
所有目标的结果写入 artifacts/releases/release-report.json。
`;

export function parseReleaseArgs(args) {
  const options = { target:null, skipChecks:false, dryRun:false, dockerCommandOnly:false, help:false, javaRoot:null, sdkRoot:null };
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--skip-checks') options.skipChecks = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--docker-command-only') options.dockerCommandOnly = true;
    else if (arg === '--java-root' || arg === '--sdk-root') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要路径参数`);
      options[arg === '--java-root' ? 'javaRoot' : 'sdkRoot'] = value;
    } else if (RELEASE_TARGETS.includes(arg.toLowerCase())) {
      if (options.target) throw new Error('每次只能选择一个发布目标；全部打包请输入 all');
      options.target = arg.toLowerCase();
    } else throw new Error(`未知参数：${arg}。执行 npm run release -- --help 查看用法`);
  }
  if (options.dockerCommandOnly && options.target && !['all','docker'].includes(options.target)) {
    throw new Error('--docker-command-only 仅适用于 all 或 docker');
  }
  return options;
}

export async function selectReleaseTarget(options,{input=process.stdin,output=process.stdout,isTTY=process.stdin.isTTY}={}) {
  if (options.target || options.help) return options;
  if (!isTTY) throw new Error('请指定发布目标，例如 npm run release -- web；执行 npm run release -- --help 查看用法');
  const reader = createInterface({input,output});
  try {
    const answer = (await reader.question('发布目标 [all / windows / web / android / docker / source]：')).trim().toLowerCase();
    if (!RELEASE_TARGETS.includes(answer)) throw new Error(`无效目标：${answer || '空输入'}。请重新运行并选择上述目标`);
    if (options.dockerCommandOnly && !['all','docker'].includes(answer)) throw new Error('--docker-command-only 仅适用于 all 或 docker');
    return {...options,target:answer};
  } finally { reader.close(); }
}

export function selectedTargets(target) {
  return target === 'all' ? ['web','windows','android','docker'] : [target];
}

export function createReleasePlan(options,{version='1.0.0',node=process.execPath,platform=process.platform}={}) {
  const targets = selectedTargets(options.target);
  const buildTargets = targets.some(target => target !== 'docker' && (target !== 'windows' || platform === 'win32'));
  const steps = [];
  if (buildTargets) {
    if (!options.skipChecks) steps.push({target:'checks',command:'npm',args:['test']});
    steps.push({target:'checks',command:'npm',args:['run','build']});
    steps.push({target:'checks',command:'npm',args:['run','data:validate']});
    steps.push({target:'checks',command:'npm',args:['run','docs:check']});
  }
  for (const target of targets) {
    if (target === 'web' || target === 'source') steps.push({target,command:node,args:['scripts/release/release-web.mjs',...(target === 'source'?['--only-source']:[])],internal:true});
    if (target === 'windows') steps.push({target,command:node,args:['scripts/release/release-windows.mjs','--reuse-build'],...(platform === 'win32'?{}:{unsupported:true,message:'Windows 便携版须在 Windows 上构建，请在 Windows 项目目录执行 release.cmd windows',buildCommand:'release.cmd windows'})});
    if (target === 'android') steps.push({target,command:node,args:['scripts/build/android-build.mjs','--mode','Release',...(options.javaRoot?['--java-root',options.javaRoot]:[]),...(options.sdkRoot?['--sdk-root',options.sdkRoot]:[])]});
    if (target === 'docker') steps.push({target,command:'docker',args:['build','-t',`noetic-atlas:${version}`,'.']});
  }
  return steps;
}

export function formatCommand(command,args) {
  const quote = value => /[\s"']/.test(value) ? `"${value.replaceAll('"','\\"')}"` : value;
  return [command,...args].map(quote).join(' ');
}

export function findNpmCli({env=process.env,node=process.execPath,platform=process.platform}={}) {
  const pathCandidates = (env.PATH || '').split(platform === 'win32'?';':':').filter(Boolean).map(directory=>resolve(directory,platform === 'win32'?'npm.cmd':'npm'));
  const resolvedNpm = pathCandidates.flatMap(path=>{try{return [realpathSync(path)];}catch{return [];}});
  const candidate = [env.npm_execpath,resolve(dirname(node),'node_modules/npm/bin/npm-cli.js'),resolve(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js'),...resolvedNpm.filter(path=>path.endsWith('npm-cli.js'))].find(path=>path&&existsSync(path));
  if (!candidate) throw new Error('无法定位 npm；请通过 npm run release -- <目标> 执行');
  return candidate;
}

export function commandAvailable(command,{path=process.env.PATH || '',platform=process.platform,pathExt=process.env.PATHEXT || '.EXE;.CMD;.BAT'}={}) {
  const extensions = platform === 'win32'?['',...pathExt.split(';')]:[''];
  for (const directory of path.split(platform === 'win32'?';':':').filter(Boolean)) for (const extension of extensions) {
    try { accessSync(resolve(directory,command+extension),platform==='win32'?constants.F_OK:constants.X_OK); return true; } catch { /* Continue searching PATH. */ }
  }
  return false;
}

function runCommand(command,args,root,env=process.env) {
  console.log(`\n> ${formatCommand(command,args)}`);
  const result = spawnSync(command,args,{cwd:root,env,stdio:'inherit',shell:false});
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? 'unknown'}`);
}

async function artifactInfo(path,output) {
  const data = await readFile(path);
  return {file:relative(output,path).replaceAll('\\','/'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}

export async function executeRelease(options,{root=resolve(import.meta.dirname,'..'),platform=process.platform}={}) {
  const {version,name} = JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  if (name !== 'noetic-atlas' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error('项目名或版本无效');
  const plan = createReleasePlan(options,{version,platform});
  if (options.dryRun) {
    console.log(`认知星图 ${version} 发布计划：${options.target}`);
    for (const step of plan) {
      if (step.unsupported) { console.log(`${step.target}：[待构建] ${step.message}`); continue; }
      const suffix = step.internal?' [内部打包，无额外构建]':step.target === 'docker' && options.dockerCommandOnly?' [仅打印，不执行]':'';
      console.log(`${formatCommand(step.command,step.args)}${suffix}`);
    }
    return {version,dryRun:true,steps:plan};
  }
  const output = resolve(root,'artifacts/releases');
  await mkdir(output,{recursive:true});
  const report = {product:'认知星图',project:name,version,generatedAt:new Date().toISOString(),requested:options.target,checksSkipped:options.skipChecks,targets:[],artifacts:[]};
  let exitCode=0;
  const writeReport = async () => {
    await writeFile(join(output,'SHA256SUMS.txt'),report.artifacts.map(item=>`${item.sha256}  ${item.file}`).join('\n')+(report.artifacts.length?'\n':''));
    await writeFile(join(output,'release-report.json'),JSON.stringify(report,null,2)+'\n');
  };
  try {
    for (const step of plan.filter(item=>item.target==='checks')) {
      runCommand(process.execPath,[findNpmCli(),...step.args],root);
    }
  } catch (error) {
    report.targets.push({target:'checks',status:'failed',message:error.message});
    await writeReport();
    throw error;
  }
  const env = {...process.env,NOETIC_RELEASE_BUILT:'1'};
  for (const target of selectedTargets(options.target)) {
    const step = plan.find(item=>item.target===target);
    try {
      if (step.unsupported) {
        console.log(`\n${target}：[待构建] ${step.message}`);
        report.targets.push({target,status:'pending',message:step.message,command:step.buildCommand});
        if (options.target === target) exitCode=2;
        continue;
      }
      if (target === 'docker') {
        const command = formatCommand(step.command,step.args);
        if (options.dockerCommandOnly || !commandAvailable('docker')) {
          const message = options.dockerCommandOnly?'按要求仅生成 Docker 构建命令，镜像待构建':'未找到 Docker，镜像待构建；安装并启动 Docker 后执行下列命令';
          console.log(`\nDocker：${message}\n${command}`);
          report.targets.push({target,status:'pending',message,command});
          if (!options.dockerCommandOnly && options.target==='docker') exitCode=2;
          continue;
        }
        runCommand(step.command,step.args,root,env);
        report.targets.push({target,status:'built',image:`noetic-atlas:${version}`,command});
        continue;
      }
      let artifacts;
      if (target === 'web' || target === 'source') {
        const packaged = await packageWebRelease({root,onlySource:target==='source'});
        artifacts=packaged.artifacts;
      } else {
        runCommand(step.command,step.args,root,env);
        const path = target==='windows'
          ? join(output,`noetic-atlas-${version}-windows-x64.zip`)
          : resolve(root,'artifacts',process.env.ANDROID_KEYSTORE?'noetic-atlas-release.apk':'noetic-atlas-release-unsigned.apk');
        artifacts=[await artifactInfo(path,output)];
      }
      report.artifacts.push(...artifacts);
      report.targets.push({target,status:'built',artifacts:artifacts.map(item=>item.file)});
    } catch (error) {
      exitCode=1;
      report.targets.push({target,status:'failed',message:error.message});
      console.error(`\n${target} 发布失败：${error.message}`);
    }
    await writeReport();
  }
  await writeReport();
  console.log(`\n发布结果：${report.targets.map(item=>`${item.target}=${item.status}`).join('，')}`);
  console.log(`产物与 SHA256：${relative(root,output).replaceAll('\\','/')}\n报告：artifacts/releases/release-report.json`);
  return {...report,exitCode};
}

export async function main(args=process.argv.slice(2)) {
  const options = parseReleaseArgs(args);
  if (options.help) { console.log(HELP); return 0; }
  const selected = await selectReleaseTarget(options);
  const report = await executeRelease(selected);
  return report.exitCode || 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(`发布终止：${error.message}`);process.exitCode=1;});
}
