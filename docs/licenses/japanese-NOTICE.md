# 日语扩展包来源、许可与审核说明

本说明适用于 `data/content-packs/japanese.json` 中的日语词卡和语法练习，以及相应导出、分享后的数据。日语数据按 **[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)** 分享；不改变应用程序自身的许可。

## 日英词典与中文学习补充

- **JMdict / EDRDG**：日语词形、假名读音、词性、英文释义。版权归 **James William Breen 和 Electronic Dictionary Research and Development Group**。项目资料：[JMdict](https://www.edrdg.org/jmdict/j_jmdict.html)，[许可原文](https://www.edrdg.org/edrdg/licence.html)。本地附有 [EDRDG许可网页](japanese-EDRDG-license.html) 和 [CC BY-SA 4.0完整条款](japanese-CC-BY-SA-4.0.txt)。
- **[jmdict-cn](https://github.com/zzhuxiaojun-glitch/jmdict-cn)**：在 JMdict 经 scriptin/jmdict-simplified 转换的数据之上增加中文释义和日中对照例句。使用固定修订 `e9eb4ab0ddb50f2f6ef7c7dafca6cf1fd4d8ca60`，上游提交时间为 2026-05-20。其中文释义及所选例句由上游 **LLM 生成**，不是经过逐词人工核定的商业辞典内容。原署名说明见 [上游 ATTRIBUTION](japanese-upstream-ATTRIBUTION.md)。本扩展包没有复制上游引用的 Tatoeba 句对，仅采用标为 `source=llm` 的例句；也未复制商业词典。
- **第三方 JLPT 分级**：上游追溯到 stephenmk/yomitan-jlpt-vocab 及 Jonathan Waller 的学习词汇资源。保留其署名链；级别标签仅作学习参考。JLPT 官方明确在 2010 改版后不发布固定词汇、汉字、语法大纲，参见[官方 FAQ](https://www.jlpt.jp/e/faq/index.html)。不能把本包称为“官方完整 N1 词表”或以标签推断考试命中率。

## 本项目做出的改动

选择、NFKC词头去重与同形词合并、将词典材料排成简答词卡、增加同音／同字构词联想及题目链接、增添学习提示和审核提示。关联是机械的学习线索，**不宣称为近义或反义关系**。没有足够关联信息时会明示缺失。

词卡共10000个不同规范化词头；全部包含假名、英文释义、中文补充、词性及日中例句。中文和例句的“人工核定覆盖率”为0；应逐批核验，并以元数据文件中的真实覆盖率为准。多义词须特别注意英中义项的对应、例句搭配及敬语。初始状态均为 **pending（待审核）**，不会自动成为已发布题。

语法练习的题干、干扰项、中文解析、易错点和追问为认知星图原创内容，也以 CC BY-SA 4.0 共享。参考日本国际交流基金 [いろどり](https://www.irodori.jpf.go.jp/) 的基础语法体系、文化厅[敬语指针](https://www.bunka.go.jp/seisaku/kokugo_nihongo/kokugo_shisaku/keigo/chapter2/detail.html)等规则资料；没有复制其习题、例句或 JLPT 真题。题目难度级别为编写者学习参考，需人工审核。

## 复现、更新与再分享

运行 `python scripts/content/japanese.py`，脚本从固定版本下载并校验SHA-256，缓存位于 `.localtools/content-sources/japanese/`。`--refresh` 重新下载同一固定版本。来源清单、哈希、条数、覆盖率见 `data/content-sources/japanese.json`。

这是一份固定学习资料快照，不是实时词典。维护者应定期检查上游（作为在线词典服务时按 EDRDG 要求至少每月更新词典源）；采用新修订时，先审核来源变更，再更新脚本中的修订号和哈希、重新生成并复核词条。不要把旧版本的人工审核结论自动用于语义已变化的新版本。

再分发本包或其改编数据时，保留本说明、EDRDG 与 jmdict-cn 署名、上游署名链、许可链接及改动说明，并继续以 CC BY-SA 4.0 或其允许的兼容许可分享对应数据。不暗示上游作者或 JLPT 官方为本项目背书。
