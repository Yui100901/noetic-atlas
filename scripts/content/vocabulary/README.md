# 词卡读音与独立释义补充

从项目根目录执行 `python scripts/content/vocabulary/enrich-vocabulary.py`。先提供原有英语和日语内容包；脚本只操作 JSON，不连接 SQLite。`--no-write-packs` 仅生成字段补丁和报告，不修改内容包。

- `.localtools/vocabulary-enrichment.json`：按原题号列出的 `vocabulary` 与新增来源引用，维护者可在备份后用 Store 事务应用。不得用旧包覆盖现有题干、释义、审核状态或学习记录。
- `data/content-sources/vocabulary/enrichment-report.json`：覆盖率、27 个双 IPA 来源缺项的逐词处理、独立释义改写、源数据 SHA-256。
- `data/content-sources/vocabulary/source-data/`：可编辑 IPA 原表、少量 Kaikki 原条目、源 README 及完整许可。发布数据包时须整体保留，现有打包器会附带 `content-sources/`。

英语主源固定为 [ipa-dict](https://github.com/open-dict-data/ipa-dict/tree/972cd67dd5f96bc5660e28070cde26e3928abcd7)：美式为 General American（源 cmudict-ipa，MIT），英式为 Received Pronunciation（源 ipacards，GPL-3.0），不可把仓库总 MIT 误当英式数据许可。上游使用人工与半自动转录，未承诺逐词人工复核。不存在某方言记录时不复制另一方言的 IPA 冒充。少数缺项采用 [Wiktionary / Kaikki](https://kaikki.org/dictionary/English/index.html) 已收录读音，遵循 [CC BY-SA 4.0](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)。单位、罗马数字及拼写变体的替代查找单独标为展开读法，保留源拼写。

日语采用原卡 JMdict 的常用假名读音，保留多读音。罗马音为赫本式规则转写：shi/chi/tsu/fu、拗音、促音、拨音 n'；长音符 ー 标 macron，ou/oo 等假名序列保留拼写以避免凭空推断音节/词素边界。它是辅助转写，不是音高、重音或字典音频核验结果；参照 [ALA-LC Japanese Romanization Table](https://www.loc.gov/catdir/cpso/romanization/japanese.pdf)。不把自动转写称为源词典自带罗马音。

`meaningPrompt` 独立于原解析，只保留必要释义，不包含词头、假名、罗马音、IPA、例句或关联词。题集设置 `practiceKind: vocabulary` 后，在开始练习或考试时选择顺向或逆向；单题页不设置方向。逆向将本次选中词卡转换为引用原题 ID 的填空卷，按原词头及原常用假名进行大小写无关、去首尾空白的字面匹配，不把近义词自动视作答案。交卷前，API 白名单不返回词卡结构、来源或参考答案。学习历史仍归原题；不另外复制一套词卡。

现有自动生成词表可运行 `npx tsx scripts/content/vocabulary/enable-wordlist-papers.ts --database data/noetic-atlas.sqlite` 预检，显式加 `--apply` 后先备份，再设置词汇题集属性并增加版本。只处理 `wordlist-english-NNN`、`wordlist-japanese-NNN` 且成员身份和结构均有效的词表，不改归档状态、题目快照或历史作答。手建题集请在编辑器自行设置用途。

运行 `node --import tsx --test tests/practice/vocabulary-set-practice.test.ts tests/practice/history-direction.test.ts` 验证整集方向、防泄题、客观判定、原题统计、迁移、分享与导出。运行 `python scripts/content/vocabulary/test_romanization.py` 验证假名转写规则。内容补充仍应根据来源和学习反馈修订；源数据许可不替代内容准确性核验。
