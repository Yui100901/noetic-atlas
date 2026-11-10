# 认知星图 · Noetic Atlas

供个人使用的本地学习平台，支持知识整理、刷题自测和持续复习，提供 Web、免安装 Windows 桌面端及 Android 端。项目名为 `noetic-atlas`。

使用 TypeScript、React、Fastify、Kysely 与 SQLite；Windows 使用 Electron，Android 使用 Capacitor 和 SQLite WASM。学习数据保存在本地，可通过文件分享或完整迁移在设备间转移。

## 主要功能

- **题库与内容维护**：自定义领域、分类、标签，支持客观题、主观题、组合题和双向词汇／概念卡；提供导入审核、查重、问题反馈及质量扫描。
- **题集与自测**：手动、随机或 AI 推荐组题，支持计分、草稿、练习计时、考试倒计时，以及题集内的错题、收藏、历史与复盘。
- **持续复习**：FSRS 自适应复习、专注复习、多领域学习计划、每日推荐、时间预算、周目标和学习统计。
- **资料与检索**：Markdown／PDF 资料、全文搜索、题目与原文互通、笔记、图片、公式和专业表达。
- **可选 AI 辅助**：解析、主观判题、编辑建议、审核、教材分块出题与推荐组题，提供进度、取消重试、失败原因和用量统计。
- **便携与数据管理**：内容 ZIP 分享、整体／领域 SQLite 迁移、恢复前副本、数据健康检查、分级学习重置和多套主题。

软件首次启动为空题库，仅带 `config/defaults.json` 基础配置，AI 默认关闭且不含凭据。领域题库包独立提供，新导入题目需审核；内容覆盖及来源许可见[题库内容与来源](./docs/题库内容与来源.md)。

## 开始使用

**Windows**：下载 `noetic-atlas-版本-windows-x64.zip`，完整解压到可写目录，双击 `noetic-atlas.exe`，无需安装 Node.js。数据默认保存在程序旁的 `data/`；更新前备份并保留整个目录。

**Android**：安装正式签名 APK。更新时沿用相同应用 ID 和签名，覆盖安装前将备份保存到应用外。安装要求与恢复步骤见[发布与部署](./docs/发布与部署.md)。

**Web／源码**：需要 Node.js **24.13 或更新的 24.x**，在项目根目录执行：

```sh
npm ci
npm run build
npm start
```

默认入口：

- 网页：[http://127.0.0.1:4317](http://127.0.0.1:4317)
- 交互式接口文档：[http://127.0.0.1:4317/api/docs/](http://127.0.0.1:4317/api/docs/)
- OpenAPI JSON：[http://127.0.0.1:4317/api/openapi.json](http://127.0.0.1:4317/api/openapi.json)

Windows 源码环境也可双击 `启动学习站.cmd`：首次或源码变化时构建，已有成功构建时快速启动。开发热更新使用 `npm run dev`，前端地址为 `http://127.0.0.1:5173`。环境变量和启动选项见[开发与维护](./docs/开发与维护.md)。

第一次学习从总览导入题库包或自己建题，审核后创建题集开始练习。已有学习库按[备份、升级与恢复](./docs/发布与部署.md#新版发布升级与回滚)接续。软件默认监听本机，适用于本地单用户使用。

## 打包与发布

三个入口共用发布流程，可交互选择，也可指定目标和版本：

| 环境 | 交互入口 | 命令示例 |
| --- | --- | --- |
| CMD | 双击 `release.cmd` | `.\release.cmd web --version 1.0` |
| PowerShell | `.\release.ps1` | `.\release.ps1 windows --version 1.0` |
| Bash | `sh ./release.sh` | `sh ./release.sh web --version 1.0` |

目标支持 `all`、`windows`、`web`、`android`、`docker`、`source`、`clean`；版本支持 `x.y` 和 `x.y.z`。完整构建示例：

```sh
npm run release -- all --version 1.0 --docker-command-only
```

Android 构建需要正式签名、JDK 21 和 Android SDK；首次创建签名与后续沿用签名的规则见[Android 构建与签名](./docs/发布与部署.md#android-构建与签名)。Docker 命令模式只输出命令，不验证镜像。

软件产物位于 `artifacts/releases/`；待上传附件和说明位于本次 `release-report.json` 的 `uploadDirectory`，不要混用旧版本目录。脚本不会自动提交代码、打标签或发布 GitHub Release。

题库导出独立运行 `npm run content:domains`，默认输出 `artifacts/domain-packs/v版本/`，与软件分开发布。清理前用 `npm run release -- clean --dry-run` 预览范围。构建要求、校验和、签名备份、数据更新及发布步骤统一见[发布与部署](./docs/发布与部署.md)。

当前首个正式版本为 **1.0**，验收范围与未测条件见[版本说明](./docs/版本说明-1.0.md)和[发布清单](./docs/1.0发布清单.md)。

## 文档

仓库文档导航见[文档目录](./docs/README.md)，日常操作也可在应用内使用手册中查阅。

| 需要了解 | 文档 |
| --- | --- |
| 日常学习、题库与迁移操作 | [使用说明书](./docs/使用说明书.md) |
| 安装、构建、更新与发布 | [发布与部署](./docs/发布与部署.md) |
| 内容来源与格式规范 | [题库内容与来源](./docs/题库内容与来源.md) · [数据包格式](./docs/数据包格式.md) |
| 开发、模块和工具 | [开发与维护](./docs/开发与维护.md) · [项目结构](./docs/项目结构.md) · [脚本与维护工具](./docs/脚本与维护工具.md) |
| 测试与实际验收范围 | [测试与验收](./docs/测试与验收.md) · [验收记录](./docs/验收记录.md) |
| 维护方向和历史记录 | [后续扩展规划](./docs/后续扩展规划.md) · [历史索引](./docs/history/README.md) |

工作数据 `data/`、个人配置、签名私钥和构建产物均不进入代码仓库；软件包仅使用公开基础配置。第三方程序资源及领域内容的许可分别随对应来源保留。
