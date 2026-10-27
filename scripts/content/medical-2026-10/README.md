# 医学、药学与中医药内容扩充（2026-10-26）

本目录只生成待审核的通用内容包，不打开工作SQLite，不自动通过审核。软件发布包仍不含题库和个人配置。

## 复现

采集工具使用Python 3、`requests`、`beautifulsoup4`和`pypdf`，构建使用项目Node.js。源网页、药典PDF和转换字典保存在被忽略的`data/content-cache/medical-2026-10/`；不随代码或内容包发布。支持资料缓存脚本下载OpenCC字典与LICENSE（Apache-2.0）及官方药典；文件SHA-256写入清单。构建还复用现有`data/content-packs/pharmacology.json`中的领域标识和安全标签，需先保留或生成该基础内容包。

```sh
node scripts/content/medical-2026-10/prepare-modern-sources.mjs
python scripts/content/medical-2026-10/cache-support.py
python scripts/content/medical-2026-10/fetch-sources.py
python scripts/content/medical-2026-10/fetch-sources.py --kind nhs
python scripts/content/medical-2026-10/extract-pharmacopoeia.py
python scripts/content/medical-2026-10/test-sources.py
node scripts/content/medical-2026-10/build.mjs
node --import tsx scripts/content/medical-2026-10/validate.ts
```

采集每站最多3并发，按URL缓存并有限重试；已有缓存不会重抓。药材、基准方、NHS资料分别生成有SHA-256的记录。构建源为`medical-expansion-20261026.json`，清单同名保存到`data/content-sources/`，质量报告在`test-results/medical-expansion/`。

## 范围和计数

- 本批共987题，均为待审核状态。
- 香港理工大学中药库408个药材条目：合并滑石粉与滑石，排除羚羊角、紫河车作为本批常用药材，保留405张学习卡。再与《台湾中药典》第四版逐名规范去重，补充53项，共458张药材与饮片卡；43张有毒药材另加风险分类。统计包括独立药用部位和炮制饮片，不等同458个植物物种，也不能统称无风险日常保健草药。未以别名、同一材料粉末形态凑到500。
- 台湾卫福部200基准方单独计数，不与药材混算；不是中国内地200个获批中成药目录。处方只列药名，不含配比、剂量或制作步骤。
- NHS来源支持的现代常用药物135项，含固定复方；排除已经有的活性成分，不按商品名、途径或相近铁盐重复凑数。
- 现代医学概念106项、中医基础60项；166张独立释义提示适合概念双向练习。药物和草药功效往往不唯一，未强行做描述反猜唯一药名。
- 另有28道中药安全、传统配伍和现代合用证据辨析客观题。

题干只保留学习问题，来源许可和通用阅读边界集中于本说明及内容清单。每题参考资料保留页面链接。原站未列禁忌时写“未列明”，绝不转换成“无禁忌”。对甘草、乌头、人参、麻黄、银杏、何首乌等增加针对性安全来源；人参与华法林研究结果不一致，不写固定方向。传统十八反十九畏和现代人体相互作用证据分别标示。

资料缺口仍明确保留：313张药材卡和154张方剂卡的核对来源没有可提取的专门注意字段；部分药材另有针对性安全补充。这是资料覆盖情况，不能视作无风险。对同一药材的药材库及药典注意事项取并集，避免补充一处时覆盖另一处风险。

## 来源、权利和版本

- [香港理工大学护理学院中药库](https://herbaltcm.sn.polyu.edu.hk/tc/)：药性、功能与具体安全事实；规范术语按事实组织成学习问答，未复制图片和长段论述。原站表达及资料保留[原版权](https://herbaltcm.sn.polyu.edu.hk/tc/copyright)，没有把其整库宣称为开放许可。
- [台湾卫福部基准方](https://dep.mohw.gov.tw/DOCMAP/lp-866-108.html)：资料按[政府网站开放宣告](https://www.mohw.gov.tw/cp-81-155-1.html)及政府资料开放授权条款第1版注明出处使用。已按现行页面划线删除记录剔除穿山甲；源项次存在重复122，题号按永久页面URL生成。
- [台湾卫福部《台湾中药典》第四版公告](https://dep.mohw.gov.tw/DOcMAP/fp-759-63293-108.html)与[官方PDF](https://www.mohw.gov.tw/dl-71936-0a89f40d-7558-4ab2-8f4b-55e58de6552b.html)：2021公告、2022生效，解析687页后提取351个含功能与用途分类的原药材条目；58个有注意事项。只提取名称、传统功能和注意，不导出剂量、实验、炮制或制作步骤。每个匹配保留名称起始页、功能页、注意页；人参PDF第163页、川乌第198页、甘草第250页已渲染核对双栏衔接。本版后续修订需另核对，未把旧版标准声称为2026实时临床指南。
- [NHS Medicines A–Z](https://www.nhs.uk/medicines/)：核对药物作用和重点风险；中文说明独立编写，不复制完整药品说明书。主要反映英国资料，不能自动套用为中国批准范围。
- [NCCIH草药相互作用](https://www.nccih.nih.gov/health/providers/digest/herb-drug-interactions-science)、[WHO传统医学术语](https://www.who.int/publications-detail-redirect/9789240042322)、NIH/NCI/NHGRI及逐题监管来源。

本批没有经过医学专家逐题审定，所有新题待审核。传统概念用于准确学习该理论体系，不宣称等同现代解剖或已证实机制；传统主治与现代临床有效性分开。没有个体诊断、剂量、炮制或解毒操作。
