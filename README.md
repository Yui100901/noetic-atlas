# 认知星图 · Noetic Atlas

本地优先、便于迁移的通用学习平台，支持课程学习、知识整理、考试与个人专题复习，提供网页、免安装 Windows 桌面端和 Android 端。使用 TypeScript、React、Fastify、Kysely 与 SQLite；Windows 通过 Electron 提供独立窗口，Android 通过 Capacitor 与 WASM SQLite 复用业务规则。项目名为 `noetic-atlas`。

## 主要功能

- 自定义领域、多级分类、标签和统一题集；初次安装为空题库，按需导入内容。
- 判断、单选、多选、填空、简答、论述与公共材料组合题；单题和批量新增审核，Markdown/PDF 资料及题目插图。
- 题集统一组织题目，可浏览、练习、考试和导出；就地查看题目并用上一题／下一题连续学习。手动、随机和 AI 推荐组题；AI 可从提示词识别范围与题量，支持大题库检索、分批推荐；可选计分、草稿恢复、顺计时练习、倒计时考试与自动交卷。
- AI 解释、主观判题、资料转换与审核；网页和桌面实时输出预览、Android 阶段进度，支持取消；按题集管理错题、收藏、复习、草稿与作答历史，卡片可直接进入；错题快照和来源独立于历史保留，组合小题可分别记录掌握、笔记与复习。
- 自包含 JSON 分享、MD/PDF 导出、SQLite/JSON 备份迁移、独立配置导入导出和 Android 离线学习；手机支持 SQLite 完整恢复、校验预览及恢复前独立备份。
- 独立领域题库包：计算机、英语、日语、语文、驾驶、化学、医学与药学；现有内容共 **30,150 个独立题号**，新导入内容默认待审核。支持中英术语、缩写辨析及按词头跳转英语释义；化学与药学共用药物题卡。覆盖与使用方法见[题库内容与来源](./docs/题库内容与来源.md)。

## 开始使用

Windows 下载 `noetic-atlas-版本-windows-x64.zip`，完整解压到可写目录后双击 `noetic-atlas.exe`，无需安装 Node.js。数据默认保存在同级 `data/`，升级前备份并保留该目录。

网页部署和源码开发需要 Node.js **24.13 或更新的 24.x**：

```sh
npm ci
npm run build
npm start
```

Windows 也可双击 `启动学习站.cmd`。默认地址：

- 网页：[http://127.0.0.1:4317](http://127.0.0.1:4317)
- 交互式接口文档：[http://127.0.0.1:4317/api/docs/](http://127.0.0.1:4317/api/docs/)
- OpenAPI JSON：[http://127.0.0.1:4317/api/openapi.json](http://127.0.0.1:4317/api/openapi.json)

接口文档在启动时根据注册路由及共用 Zod 校验器自动生成。开发使用 `npm run dev`，前端位于 `http://127.0.0.1:5173`。数据库首次启动创建于 `data/noetic-atlas.sqlite`，可配置 `DATABASE_PATH`、`SEED_PATH`、`PORT` 和 `HOST`。

旧版独立题库集合会在数据库启动或旧 JSON 导入时转换为题集，保留题目顺序和内容，历史作答不变。大型题集完整保留，每次练习或考试最多500个作答项，开始前明确选择本次题量和顺序／随机方式。

软件不携带任何题目、领域、分类或标签，仅附`config/defaults.json`基础配置。AI默认关闭，端点、模型与凭据由使用者填写。独立题库包通过“分享与导入”添加，新题进入待审核。

## 打包与发布

三个入口支持交互选择或直接传目标，均调用同一个发布流程：

| 环境 | 交互选择 | 直接指定目标 |
| --- | --- | --- |
| Windows CMD | 双击 `release.cmd` | `.\release.cmd web` |
| PowerShell | `.\release.ps1` | `.\release.ps1 all` |
| Linux / Bash | `sh ./release.sh` | `sh ./release.sh web` |

也可运行 `npm run release -- all`，目标支持 `all`、`windows`、`web`、`android`、`docker`、`source`、`clean`；`--dry-run` 查看计划，`--docker-command-only` 仅输出 Docker 命令。`all` 构建当前系统支持的版本，Linux/macOS 不构建 Windows 桌面包。`android` 和 `all` 在构建前检查正式签名、JDK 21 与 Android SDK，缺失时停止。构建输出位于 `artifacts/releases/`，包含版本化签名 APK、签名验证报告、清单与 SHA256。

新版发布需同步版本号、完成检查再打包；升级先备份并停止旧程序，保留原数据库。各目标工具链、Docker部署、Android签名、升级与回滚见[发布与部署](./docs/发布与部署.md)。在有本地题库的开发环境运行`npm run content:domains`，将现有通用已发布题按领域导出为多个独立ZIP；使用方法见[说明书](./docs/使用说明书.md#扩展内容包)。

Android 首次正式发布运行 `npm run android:signing:init` 创建本地签名，之后正式打包自动使用；请独立备份私钥和密码，详见[Android 构建与签名](./docs/发布与部署.md#android-构建与签名)。

检查与打包成功后，脚本自动生成新的 `artifacts/github/v版本-UTC运行时间-pid/` 待上传目录和发布说明，具体路径见 `artifacts/releases/release-report.json` 的 `uploadDirectory`。通常无需再运行 `release:prepare`；题库 ZIP 作为独立附件另行选择。首次推送、打标签和创建 Release 的步骤见[发布流程](./docs/发布与部署.md#首次发布到github)。

`data/` 整个目录忽略，不提交 Git。配置在“系统配置 → 数据与备份”单独导出、预览导入，AI 密钥不会进入配置文件。发布完成后可先运行 `npm run release -- clean --dry-run` 查看实际清理计划，再运行 `npm run release -- clean`：将领域题库包校验归档至 `data/release-archives/domain-packs/`，删除可重建的软件发布与打包产物，保留工作数据、正式签名和工具链。三个脚本入口也支持 `clean`，无需安装构建依赖；原 `npm run release:clean` 仍可使用，详见[清理与归档](./docs/发布与部署.md#发布产物清理与题库归档)。

## 文档

- [使用说明书](./docs/使用说明书.md)：功能规则、审核、学习与迁移操作。
- [题库内容与来源](./docs/题库内容与来源.md)：各领域数量、覆盖、许可与复现方法。
- [术语概念卡](./docs/术语概念卡.md)：双语名称、缩写、概念辨析与可迁移英文引用。
- [开发与维护](./docs/开发与维护.md) · [架构与迁移](./docs/架构与迁移.md) · [API 约定](./API-CONTRACT.md)。
- [项目结构](./docs/项目结构.md)：模块边界、稳定入口和新增代码的放置约定。
- [发布与部署](./docs/发布与部署.md) · [验收记录](./docs/验收记录.md)。
- [查询性能与数据库访问](./docs/查询性能与数据库访问.md)：性能测量、统一查询层及数据库替换边界。

当前面向本地单用户使用，默认只监听本机。设备验证与测试范围以验收记录为准。
