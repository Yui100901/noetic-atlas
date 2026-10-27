# 2026-10-26 重要概念扩展

```powershell
node --import tsx scripts/content/concepts-2026-10/build.mjs
```

脚本读取原始 `data/seed.json` 和既有 `data/content-packs/` 作同名去重，输出各领域独立增量包、来源说明和现有概念元数据补充清单；不打开工作SQLite、不修改审核状态。新题全部为待审核简答概念卡，每张都显式编写不含概念名的短定义供双向练习；原有长解析继续用于查阅。

`concept-metadata-plan-20261026.json` 的 `sourceFingerprint` 是 `SHA256(JSON.stringify([id,title,type,stemMarkdown,answerMarkdown,explanationMarkdown]))`。应用前核对题目正文指纹，补充只增加 `concept` 字段，保留ID、正文、审核状态和学习记录；药学内容由独立医学批次处理。明确的单一术语才自动整理，词汇卡、案例问句、多个概念的比较题和不能得到无泄词短定义的条目留在原题型。

内容是独立编写的基础事实概要和辨析，参考官方文档、OpenStax教材、学术机构与政府资料核验；不复制原题、图片和大段教材。来源链接保留在 `sourceRefs` 和整批来源记录，题干不放许可或通用学习说明。同名去重不宣称已完成全部语义查重，后续可借助站内相似题和用户反馈继续核查。
