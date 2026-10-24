# 常用知识与基础考点扩展

本轮覆盖11个已有领域，新增880题：计算机200，英语/日语/语文/驾驶/化学/医药各60，地理/物理/心理/经济各80。题干、情境、选项与解析独立整理；互联网权威来源用于核对概念、公式、规则和课程范围，不复制商业题库或教材正文。语言类不新增词汇卡。

生成前需已有 `data/content-packs/` 基础内容，因为领域与共享学习方式标签沿用现有身份。命令从项目根目录执行：

```sh
node scripts/content/common-2026-10/build-common.mjs
node --import tsx scripts/qa/audit-common.ts --database data/noetic-atlas.sqlite
npx tsx scripts/content/common-2026-10/apply-common.ts --database data/noetic-atlas.sqlite
```

生成内容写入11份 `*-common-202610.json`，全部为待审核；逐包来源摘要写入 `data/content-sources/`。D/L保留难度与深度，F为特定课程/技能复习范围的编辑建议，不是统计考试命中率。公共标签区分概念与应用，领域主题标签保留领域归属。

最后一条默认只预检。用户已明确授权批准本轮与上一批时，才显式加 `--apply`：先建立并验证备份，再在同一事务内导入新增题并批准指定批次。作用范围是本轮11包及上轮11份foundation包的题号；不批准无关自建题，不重建已删除题，不修改私人学习记录或历史卷面。重复执行不会回退审核状态或覆盖本地题目修改。

```sh
npx tsx scripts/content/common-2026-10/apply-common.ts --database data/noetic-atlas.sqlite --apply
node --import tsx scripts/qa/check-common-applied.ts
npm run content:domains -- --output artifacts/domain-packs/common-20261024
```

默认领域导出只包含已发布通用题，接收方分享导入仍默认待审核。`data/`、`artifacts/`与`test-results/`继续被Git忽略，软件空安装配置不变。审批报告与备份路径属于本地维护信息，只写入`test-results/`。
