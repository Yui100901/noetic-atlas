# 音乐记谱图例

本目录生成原创教学布局，Bravura提供标准SMuFL记谱字形。字体版本与SHA-256固定在 `font-source.json`，SIL OFL 1.1全文在 `LICENSE-Bravura.txt`。中文说明使用项目已有Noto Sans SC；两种字体均先转为路径，再输出PNG，学生端无需字体、第三方CDN或记谱库。

图例及字体缓存保存于被忽略的 `data/content-sources/`。字体首次构建会从固定上游版本下载并核对摘要；已缓存时离线生成。运行PNG构建需要Playwright，可安装到开发环境，或用环境变量 `PLAYWRIGHT_MODULE` 指向已有Playwright模块；浏览器默认Edge，可设置 `PLAYWRIGHT_CHANNEL`。

```sh
node scripts/content/music-notation/build.mjs
```

`diagrams.mjs` 定义路径、谱例布局及题目映射。`enrich.mjs`由音乐作者包构建自动调用，按需要把PNG作为普通题目附件放入包中，保持题号稳定。字体出处和许可集中记录，题干不添加许可说明。

单个符号可以放在已命名概念旁；带定义、对照或解题线索的谱例放入解析。客观题不在作答前添加答案图例，概念逆向提示不被修改。分享JSON会附带相应图片。

对已有工作库应用图例：

```sh
node --import tsx scripts/content/music-notation/apply.ts
node --import tsx scripts/content/music-notation/apply.ts --apply
```

默认仅在临时副本预览；显式应用先备份、再在副本预检，之后事务更新。保留原题答案、审核状态和学习记录；当前题集中的匹配快照产生新版本，已创建的历史作答不变。与原题不同的自定义题集快照不会被覆盖。
