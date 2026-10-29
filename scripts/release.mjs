/** One release entry point. Importing this module never runs a build. */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { packageWebRelease } from './release/release-web.mjs';
import { collectSignedAndroidArtifact } from './release/android-artifact.mjs';
import { prepareGithubRelease } from './release/prepare-github.mjs';
import { findNpmCli, formatCommand } from './build/build-command.mjs';
import { cleanupReleaseArtifacts } from './release/cleanup.mjs';
import {
  normalizeReleaseVersion,
  validateReleaseVersion,
  expectedReleaseArtifacts,
  selectReleaseVersion,
  syncReleaseVersion,
} from './release/version.mjs';
export { selectReleaseVersion } from './release/version.mjs';
export { findNpmCli, formatCommand } from './build/build-command.mjs';
const PROJECT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const RELEASE_TARGETS = ['all', 'windows', 'web', 'android', 'docker', 'source', 'clean'];
export const HELP = `认知星图一键发布

用法：npm run release -- [all|windows|web|android|docker|source|clean] [选项]
      双击 release.cmd 后输入目标，也可执行 release.cmd windows
      PowerShell：.\\release.ps1 web；Linux / macOS：./release.sh web

  all       Web 源码/运行包 + Windows 便携版 + Android 正式构建 + Docker 镜像
  windows   Windows x64 便携版 ZIP，解压后双击启动
  web       Web 源码和运行包 ZIP
  android   Android Release APK（读取本地正式签名或完整签名环境变量）
  docker    执行 docker build -t noetic-atlas:<版本> .
  source    仅源码 ZIP
  clean     校验归档领域题库包后清理软件产物，保留工作数据、密钥和工具链

  --skip-checks          跳过自动化测试；仍构建并校验公开数据和文档
  --dry-run              仅显示计划，不执行命令、不生成文件
  --version <版本>      指定 x.y 或 x.y.z，也可附 -rc.1 或前导v；不创建Git标签或运行版本hooks
  --docker-command-only  只打印 Docker 构建命令，不调用 Docker
  --java-root <路径>     Android 构建使用的 Java 21 路径（或 JAVA_HOME）
  --sdk-root <路径>      Android SDK 路径（或 ANDROID_HOME）
  --help                显示帮助

all 在未安装 Docker 时会继续生成其他包，并明确将 Docker 标记为待构建。
Windows 便携版必须在 Windows 构建；其他系统执行 all 时会将其标记为待构建。
单独 docker 且未安装 Docker 时退出码为 2；--docker-command-only 退出码为 0。
android / all 必须配置正式签名，缺失时在构建前停止，不生成未签名发布包。
所有软件包（含版本化签名 APK）写入 artifacts/releases/。
检查通过后自动生成 artifacts/github/ 下新的待上传目录及发布说明。
clean 不构建或安装依赖；clean --dry-run 查看真实清理计划，不修改文件。
未指定版本时，交互终端会询问（回车保留当前版本）；非交互命令沿用当前版本。
clean 不询问版本且不接受 --version；dry-run 仅预览版本和文件名，不修改版本文件。
`;

function validateTargetOptions(options) {
  if (
    options.target === 'clean' &&
    (options.skipChecks ||
      options.javaRoot ||
      options.sdkRoot ||
      options.dockerCommandOnly ||
      options.version)
  ) {
    throw new Error('clean 仅支持 --dry-run 和 --help，不能与构建专用选项混用');
  }
  if (options.dockerCommandOnly && options.target && !['all', 'docker'].includes(options.target)) {
    throw new Error('--docker-command-only 仅适用于 all 或 docker');
  }
  return options;
}

export function parseReleaseArgs(args) {
  const options = {
    target: null,
    skipChecks: false,
    dryRun: false,
    dockerCommandOnly: false,
    help: false,
    javaRoot: null,
    sdkRoot: null,
    version: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--skip-checks') options.skipChecks = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--docker-command-only') options.dockerCommandOnly = true;
    else if (arg === '--version') {
      if (options.version) throw new Error('--version 只能指定一次');
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--version 需要版本参数');
      options.version = normalizeReleaseVersion(value);
    } else if (arg === '--java-root' || arg === '--sdk-root') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要路径参数`);
      options[arg === '--java-root' ? 'javaRoot' : 'sdkRoot'] = value;
    } else if (RELEASE_TARGETS.includes(arg.toLowerCase())) {
      if (options.target) throw new Error('每次只能选择一个发布目标；全部打包请输入 all');
      options.target = arg.toLowerCase();
    } else throw new Error(`未知参数：${arg}。执行 npm run release -- --help 查看用法`);
  }
  return validateTargetOptions(options);
}

export async function selectReleaseTarget(
  options,
  { input = process.stdin, output = process.stdout, isTTY = process.stdin.isTTY } = {},
) {
  if (options.target || options.help) return validateTargetOptions(options);
  if (!isTTY)
    throw new Error(
      '请指定发布目标，例如 npm run release -- web；执行 npm run release -- --help 查看用法',
    );
  const reader = createInterface({ input, output });
  try {
    const answer = (await reader.question(`发布目标 [${RELEASE_TARGETS.join(' / ')}]：`))
      .trim()
      .toLowerCase();
    if (!RELEASE_TARGETS.includes(answer))
      throw new Error(`无效目标：${answer || '空输入'}。请重新运行并选择上述目标`);
    return validateTargetOptions({ ...options, target: answer });
  } finally {
    reader.close();
  }
}

export function selectedTargets(target) {
  return target === 'all' ? ['web', 'windows', 'android', 'docker'] : [target];
}

export function createReleasePlan(
  options,
  { version = PROJECT_VERSION, node = process.execPath, platform = process.platform } = {},
) {
  validateTargetOptions(options);
  if (options.target === 'clean')
    return [
      {
        target: 'clean',
        command: node,
        args: ['scripts/release/cleanup.mjs', ...(options.dryRun ? ['--dry-run'] : [])],
      },
    ];
  version = validateReleaseVersion(options.version || version, options.target);
  const targets = selectedTargets(options.target);
  const buildTargets = targets.some(
    (target) => target !== 'docker' && (target !== 'windows' || platform === 'win32'),
  );
  const steps = [];
  if (buildTargets) {
    steps.push({ target: 'checks', command: 'npm', args: ['run', 'check'] });
    if (!options.skipChecks) steps.push({ target: 'checks', command: 'npm', args: ['test'] });
    steps.push({ target: 'checks', command: 'npm', args: ['run', 'build'] });
    steps.push({ target: 'checks', command: 'npm', args: ['run', 'data:validate'] });
  }
  for (const target of targets) {
    if (target === 'web' || target === 'source')
      steps.push({
        target,
        command: node,
        args: [
          'scripts/release/release-web.mjs',
          ...(target === 'source' ? ['--only-source'] : []),
        ],
        internal: true,
      });
    if (target === 'windows')
      steps.push({
        target,
        command: node,
        args: ['scripts/release/release-windows.mjs', '--reuse-build'],
        ...(platform === 'win32'
          ? {}
          : {
              unsupported: true,
              message:
                'Windows 便携版须在 Windows 上构建，请在 Windows 项目目录执行 release.cmd windows',
              buildCommand: 'release.cmd windows',
            }),
      });
    if (target === 'android')
      steps.push({
        target,
        command: node,
        args: [
          'scripts/build/android-build.mjs',
          '--mode',
          'Release',
          ...(options.javaRoot ? ['--java-root', options.javaRoot] : []),
          ...(options.sdkRoot ? ['--sdk-root', options.sdkRoot] : []),
        ],
      });
    if (target === 'docker')
      steps.push({
        target,
        command: 'docker',
        args: ['build', '-t', `noetic-atlas:${version}`, '.'],
      });
  }
  return steps;
}

export function commandAvailable(
  command,
  {
    path = process.env.PATH || '',
    platform = process.platform,
    pathExt = process.env.PATHEXT || '.EXE;.CMD;.BAT',
  } = {},
) {
  const extensions = platform === 'win32' ? ['', ...pathExt.split(';')] : [''];
  for (const directory of path.split(platform === 'win32' ? ';' : ':').filter(Boolean))
    for (const extension of extensions) {
      try {
        accessSync(
          resolve(directory, command + extension),
          platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return true;
      } catch {
        /* Continue searching PATH. */
      }
    }
  return false;
}

function runCommand(command, args, root, env = process.env) {
  console.log(`\n> ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? 'unknown'}`);
}

async function artifactInfo(path, output) {
  const data = await readFile(path);
  return {
    file: relative(output, path).replaceAll('\\', '/'),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

export async function executeRelease(
  options,
  {
    root = resolve(import.meta.dirname, '..'),
    platform = process.platform,
    env = process.env,
    commandRunner = runCommand,
  } = {},
) {
  validateTargetOptions(options);
  if (options.target === 'clean') {
    const cleanup = await cleanupReleaseArtifacts({ root, dryRun: options.dryRun });
    console.log(JSON.stringify(cleanup, null, 2));
    return { target: 'clean', ...cleanup, exitCode: 0 };
  }
  const { version: currentVersion, name } = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  );
  if (name !== 'noetic-atlas') throw new Error('项目名或版本无效');
  normalizeReleaseVersion(currentVersion);
  const version = validateReleaseVersion(options.version || currentVersion, options.target);
  const expectedArtifacts = expectedReleaseArtifacts(options.target, version);
  const plan = createReleasePlan(options, { version, platform });
  if (options.dryRun) {
    console.log(`认知星图 ${version} 发布计划：${options.target}`);
    console.log(`预期版本化产物：${expectedArtifacts.join('，')}`);
    for (const step of plan) {
      if (step.unsupported) {
        console.log(`${step.target}：[待构建] ${step.message}`);
        continue;
      }
      const suffix = step.internal
        ? ' [内部打包，无额外构建]'
        : step.target === 'docker' && options.dockerCommandOnly
          ? ' [仅打印，不执行]'
          : '';
      console.log(`${formatCommand(step.command, step.args)}${suffix}`);
    }
    return { version, dryRun: true, steps: plan, expectedArtifacts };
  }
  // Fail before tests or any packages are created when the requested APK cannot
  // be a signed release. Never manufacture or replace a publisher's key.
  let buildEnv = { ...env, NOETIC_RELEASE_BUILT: '1' };
  if (selectedTargets(options.target).includes('android')) {
    const { preflightAndroidRelease } = await import('./build/android-build.mjs');
    const preflight = await preflightAndroidRelease(options, { root, platform, env: buildEnv });
    buildEnv = preflight.env;
    options = { ...options, javaRoot: preflight.javaRoot, sdkRoot: preflight.sdkRoot };
    const android = plan.find((item) => item.target === 'android');
    android.args = createReleasePlan(options, { version, platform }).find(
      (item) => item.target === 'android',
    ).args;
  }
  // Complete signing/toolchain preflight before touching the publisher's version.
  // Unsupported/command-only targets do not construct an artifact or alter metadata.
  const willBuild =
    plan.some((step) => step.target === 'checks') ||
    (selectedTargets(options.target).includes('docker') &&
      !options.dockerCommandOnly &&
      commandAvailable('docker'));
  const versionChange = willBuild ? await syncReleaseVersion(root, version) : null;
  let succeeded = false;
  try {
    const output = resolve(root, 'artifacts/releases');
    await mkdir(output, { recursive: true });
    const report = {
      product: '认知星图',
      project: name,
      version,
      generatedAt: new Date().toISOString(),
      requested: options.target,
      checksSkipped: options.skipChecks,
      targets: [],
      artifacts: [],
    };
    let exitCode = 0;
    const writeReport = async () => {
      await writeFile(
        join(output, 'SHA256SUMS.txt'),
        report.artifacts.map((item) => `${item.sha256}  ${item.file}`).join('\n') +
          (report.artifacts.length ? '\n' : ''),
      );
      await writeFile(join(output, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');
    };
    try {
      for (const step of plan.filter((item) => item.target === 'checks')) {
        commandRunner(
          process.execPath,
          [findNpmCli({ env: buildEnv }), ...step.args],
          root,
          buildEnv,
        );
      }
    } catch (error) {
      report.targets.push({ target: 'checks', status: 'failed', message: error.message });
      await writeReport();
      throw error;
    }
    for (const target of selectedTargets(options.target)) {
      const step = plan.find((item) => item.target === target);
      try {
        if (step.unsupported) {
          console.log(`\n${target}：[待构建] ${step.message}`);
          report.targets.push({
            target,
            status: 'pending',
            message: step.message,
            command: step.buildCommand,
          });
          if (options.target === target) exitCode = 2;
          continue;
        }
        if (target === 'docker') {
          const command = formatCommand(step.command, step.args);
          if (options.dockerCommandOnly || !commandAvailable('docker')) {
            const message = options.dockerCommandOnly
              ? '按要求仅生成 Docker 构建命令，镜像待构建'
              : '未找到 Docker，镜像待构建；安装并启动 Docker 后执行下列命令';
            console.log(`\nDocker：${message}\n${command}`);
            report.targets.push({ target, status: 'pending', message, command });
            if (!options.dockerCommandOnly && options.target === 'docker') exitCode = 2;
            continue;
          }
          commandRunner(step.command, step.args, root, buildEnv);
          report.targets.push({
            target,
            status: 'built',
            image: `noetic-atlas:${version}`,
            command,
          });
          continue;
        }
        let artifacts;
        if (target === 'web' || target === 'source') {
          const packaged = await packageWebRelease({ root, onlySource: target === 'source' });
          artifacts = packaged.artifacts;
        } else {
          commandRunner(step.command, step.args, root, buildEnv);
          if (target === 'android') {
            const signed = await collectSignedAndroidArtifact({ root, output, version });
            artifacts = [signed.artifact];
            report.androidSigning = signed.signature;
          } else
            artifacts = [
              await artifactInfo(join(output, `noetic-atlas-${version}-windows-x64.zip`), output),
            ];
        }
        report.artifacts.push(...artifacts);
        report.targets.push({
          target,
          status: 'built',
          ...(target === 'android' ? { signed: true, installable: true } : {}),
          artifacts: artifacts.map((item) => item.file),
        });
      } catch (error) {
        exitCode = 1;
        report.targets.push({ target, status: 'failed', message: error.message });
        console.error(`\n${target} 发布失败：${error.message}`);
      }
      await writeReport();
    }
    await writeReport();
    if (exitCode === 0 && report.artifacts.length && !report.checksSkipped) {
      try {
        const stamp = new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d+Z$/, 'Z');
        const uploaded = await prepareGithubRelease({
          root,
          output: join(root, 'artifacts/github', `v${version}-${stamp}-${process.pid}`),
        });
        report.uploadDirectory = relative(root, uploaded.output).replaceAll('\\', '/');
        await writeReport();
        console.log(`可直接上传的附件与发布说明：${report.uploadDirectory}`);
      } catch (error) {
        exitCode = 1;
        report.targets.push({ target: 'prepare', status: 'failed', message: error.message });
        await writeReport();
        console.error(`发布附件整理失败：${error.message}`);
      }
    }
    console.log(
      `\n发布结果：${report.targets.map((item) => `${item.target}=${item.status}`).join('，')}`,
    );
    console.log(
      `产物与 SHA256：${relative(root, output).replaceAll('\\', '/')}\n报告：artifacts/releases/release-report.json`,
    );
    succeeded = exitCode === 0;
    return { ...report, exitCode };
  } finally {
    if (!succeeded && versionChange) {
      try {
        await versionChange.rollback();
      } catch (error) {
        console.error(`发布失败且版本回滚未完成：${error.message}`);
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseReleaseArgs(args);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const selected = await selectReleaseVersion(await selectReleaseTarget(options));
  // Select first: interactive clean/help/plans must also work without a build
  // dependency installation. All three shell wrappers use this single decision.
  if (!selected.dryRun && createReleasePlan(selected).some((step) => step.target === 'checks')) {
    const root = resolve(import.meta.dirname, '..');
    const dependencies = ['@electron/packager', 'tsx', 'typescript'];
    if (
      dependencies.some((name) => !existsSync(join(root, 'node_modules', name, 'package.json')))
    ) {
      runCommand(process.execPath, [findNpmCli(), 'ci', '--include=dev'], root, {
        ...process.env,
        ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
      });
    }
  }
  const report = await executeRelease(selected);
  return report.exitCode || 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`发布终止：${error.message}`);
      process.exitCode = 1;
    });
}
