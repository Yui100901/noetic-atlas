import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { groups, officialSources } from './chemistry-organic-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const generatedAt = '2026-10-22T00:00:00.000Z';
const manifestPath = path.join(root, 'data/content-sources/chemistry-organic.json');
const cachePath = path.join(root, '.localtools/content-sources/chemistry-organic-identities.json');
const materialSources = {
  repeatUnit: 'https://goldbook.iupac.org/terms/view/C01286',
  chainGrowth: 'https://openstax.org/books/organic-chemistry/pages/31-2-chain-growth-polymers',
  stepGrowth: 'https://openstax.org/books/organic-chemistry/pages/31-4-step-growth-polymers',
  nylon: 'https://openstax.org/books/organic-chemistry/pages/21-9-polyamides-and-polyesters-step-growth-polymers',
  properties: 'https://openstax.org/books/organic-chemistry/pages/31-7-polymer-structure-and-physical-properties',
  polycarbonate: 'https://solutions.covestro.com/en/products/makrolon/makrolon-2605_000000000000894068',
  pla: 'https://natureworksllc.com/resources/material-health-and-safety',
  ptfe: 'https://www.chemours.com/en/industries-applications/application-development/continuous-innovation',
  ptfeHeat: 'https://www.cdc.gov/niosh/hhe/reports/pdfs/81-129-1455.pdf',
  surfactants: 'https://www.epa.gov/saferchoice/safer-choice-criteria-surfactants',
  cleaning: 'https://www.epa.gov/saferchoice/standard',
  xylitol: 'https://www.fda.gov/animal-veterinary/animal-health-literacy/paws-xylitol-toxic-dogs',
  erythritol: 'https://www.efsa.europa.eu/en/efsajournal/pub/8430',
  thf: 'https://www.inchem.org/documents/icsc/icsc/eics0578.htm',
  dioxane: 'https://www.inchem.org/documents/icsc/icsc/eics0041.htm'
};
const materialDetailSources = {
  Starch: ['https://www.inchem.org/documents/icsc/icsc/eics1553.htm', 'WHO/ILO ICSC 1553：淀粉与粉尘边界'],
  Cellulose: ['https://www.fao.org/4/w6355e/w6355e0l.htm', 'FAO/JECFA：纤维素重复组成及微晶纤维素专门规格，勿外推所有纤维素商品'],
  Pectin: ['https://www.fao.org/fileadmin/user_upload/jecfa_additives/docs/Monograph1/Additive-306.pdf', 'FAO/JECFA：果胶组成和酯化身份'],
  'Sodium-Alginate': ['https://www.fao.org/4/w6355e/w6355e0x.htm', 'FAO/JECFA：海藻酸钠重复组成与结构变异'],
  Polyethylene: ['https://www.inchem.org/documents/icsc/icsc/eics1488.htm', 'WHO/ILO ICSC 1488：聚乙烯'],
  Polypropylene: ['https://www.lyondellbasell.com/497038/globalassets/sites/2023/index/polypropylene-resins.pdf', 'LyondellBasell：聚丙烯树脂与牌号用途，具体物性不外推全部成品'],
  'Polyvinyl-Chloride': ['https://inchem.org/documents/icsc/icsc/eics1487.htm', 'WHO/ILO ICSC 1487：PVC及配方差异'],
  Polystyrene: ['https://www.inchem.org/documents/icsc/icsc/eics1043.htm', 'WHO/ILO ICSC 1043：聚苯乙烯'],
  'Polymethyl-Methacrylate': ['https://www.plexiglas-polymers.com/files/assets/04-molding_compounds/plexiglas-polymers/downloads/en/product-information/PLEXIGLAS_Resist/PLEXIGLAS%20Resist%20AG%20100_EN.pdf', 'Röhm：PMMA具体牌号和材料身份，勿外推全部制品'],
  Polydimethylsiloxane: ['https://www.dow.com/en-us/pdp.dowsil-sh-200-fluid-15-cst.02482401h.html', 'Dow：PDMS流体具体产品，牌号决定性能和适用范围'],
  'Acrylonitrile-Butadiene-Styrene': ['https://www.sabic.com/en/products/polymers/acrylonitrile-butadiene-styrene-abs/cycolac-resin', 'SABIC：ABS多相组成与牌号差异'],
  Polyacrylamide: ['https://www.basf.com/gb/en/media/news-releases/2018/05/Bradford_opening', 'BASF：聚丙烯酰胺水处理、造纸及工业用途'],
  'Sodium-Polyacrylate': ['https://inchem.org/documents/icsc/icsc/eics1429.htm', 'WHO/ILO ICSC 1429：聚丙烯酸钠与聚合物变异'],
  Triglyceride: ['https://codex.fao.org/ar/codex-texts/codex-online-databases/gsfa/food-categories/food-category-details?categoryId=d972ded6-249a-f111-b8dc-70a8a5613865', 'FAO/Codex：食用油脂主要为脂肪酸甘油三酯，不是单一化合物']
};
const records = groups.flatMap(group => group.rows.trim().split(/\r?\n/).filter(Boolean).map(line => {
  const fields = line.split('|').map(value => value.trim());
  if (fields.length !== 7 || fields.some(value => !value)) throw new Error(`Invalid catalog row ${line}`);
  const [name, formula, lookup, properties, reaction, uses, safety] = fields;
  return { group, name, formula, lookup, properties, reaction, uses, safety, variable: /无唯一|重复|^\[/.test(formula) };
}));
if (records.length !== 120 || new Set(records.map(x => x.name)).size !== 120) throw new Error('Expected 120 distinct organic/material cards');
// Generic name resolution can choose a hydrate, protonated representation or
// parent acid. Pin reviewed PubChem records for the specifically stated salts.
const pinnedCidByLookup = { 'Monosodium-Glutamate': 70788954, 'Disodium-EDTA': 8759, 'Sodium-Dodecyl-Sulfate': 3423265 };

const formulaAtoms = formula => {
  const found = new Map();
  let consumed = '';
  for (const match of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    consumed += match[0]; found.set(match[1], (found.get(match[1]) || 0) + Number(match[2] || 1));
  }
  if (consumed !== formula) throw new Error(`Formula is not a simple molecular formula: ${formula}`);
  return JSON.stringify([...found].sort(([a], [b]) => a.localeCompare(b)));
};
let identities = {};
for (const sourcePath of [manifestPath, cachePath]) {
  try { const cached = JSON.parse(await fs.readFile(sourcePath, 'utf8')); identities = { ...identities, ...(cached.identities || cached) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (process.argv.includes('--refresh-identities')) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  let calls = 0;
  for (const record of records.filter(record => !record.variable)) {
    if (process.argv.includes('--resume-identities') && identities[record.lookup] && formulaAtoms(record.formula.split('（')[0]) === formulaAtoms(identities[record.lookup].formula)) continue;
    let api, response;
    for (const lookup of new Set([record.lookup, record.lookup.replaceAll('-', ' ')])) {
      api = pinnedCidByLookup[record.lookup]
        ? `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${pinnedCidByLookup[record.lookup]}/property/MolecularFormula/JSON`
        : `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(lookup)}/property/MolecularFormula/JSON`;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetch(api, { signal: AbortSignal.timeout(30000) });
        if (response.ok || response.status === 404) break;
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
      if (response.ok) break;
    }
    if (!response.ok) throw new Error(`PubChem lookup failed: ${record.name}: ${response.status} (${api})`);
    const json = await response.json(), match = json.PropertyTable?.Properties?.[0];
    if (!match?.CID || !match.MolecularFormula) throw new Error(`Missing PubChem molecular identity: ${record.name}`);
    identities[record.lookup] = { cid: match.CID, formula: match.MolecularFormula, api, checkedAt: generatedAt };
    await fs.writeFile(cachePath, `${JSON.stringify(identities, null, 2)}\n`);
    if (++calls % 10 === 0) console.log(`Verified molecular identities: ${calls}`);
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}
for (const record of records.filter(record => !record.variable)) {
  const identity = identities[record.lookup];
  if (!identity) throw new Error(`Missing molecular identity for ${record.name}; run node scripts/content/chemistry/chemistry-organic.mjs --refresh-identities`);
  const expectedFormula = record.formula.split('（')[0];
  if (formulaAtoms(expectedFormula) !== formulaAtoms(identity.formula)) throw new Error(`Formula mismatch ${record.name}: catalog=${expectedFormula}; PubChem CID ${identity.cid}=${identity.formula}`);
}

const categories = [
  { id: 'chem-org-root', name: '有机与食品材料化学', description: '常见有机小分子、食品组分与聚合材料。', domainId: 'chemistry', parentId: null, sortOrder: 1 },
  ...groups.map((group, i) => ({ id: `chem-org-cat-${group.id}`, name: group.name, description: group.description, domainId: 'chemistry', parentId: 'chem-org-root', sortOrder: i + 1 }))
];
const tagDefinitions = [
  ['identity', '物质身份与化学式', '区分异构体、盐、水合物、纯物质与混合物。'],
  ['reaction', '有机反应与机制', '官能团反应、酸碱、氧化还原、成酯水解或材料变化。'],
  ['safety', '化学品安全边界', '区分原料与成品、暴露途径、纯度等级及危险性。'],
  ['daily', '生活化学', '日常清洁、材料和常见生活用品中的化学。'],
  ['industrial', '工业化学品', '受控工业用途，不代表可以家庭操作。'],
  ['food', '食品组分与添加剂', '物质知识不代替适用地区现行食品许可与限量。'],
  ['fuel', '燃料与烃', '烃结构、燃烧边界与燃料配方。'],
  ['solvent', '有机溶剂', '溶解、分相、溶剂化及相容性。'],
  ['alcohol', '醇与酚', '醇羟基、酚羟基和多羟基结构。'],
  ['carbonyl', '醛酮与羰基', '醛、酮及相关羰基反应。'],
  ['carboxylic', '羧酸与羧酸盐', '羧基中和、离解、水解及配位。'],
  ['ester', '酯与水解', '酯键形成、水解及侧链/主链区别。'],
  ['sugar', '糖与多糖', '糖苷键、还原糖、糖醇与多糖结构。'],
  ['amino', '氨基酸与肽键', '两性离子、侧链官能团及肽键。'],
  ['polymer', '聚合物与重复单元', '链长、端基、共聚、交联与分子量分布。'],
  ['mixture', '混合物与配方', '无唯一分子式的多组分产品。'],
  ['surfactant', '表面活性与胶束', '两亲结构、界面、硬水及胶束。'],
  ['isomer', '同分异构与立体化学', '同分子式不同键连或立体构型。'],
  ['regulation', '用途规格与许可核对', '现行法规、成品等级与具体许可需按地区和时间核对。']
];
const tags = tagDefinitions.map(([slug, name, description]) => ({ id: `chem-org-${slug}`, name, description, color: '#177c63', domainId: 'chemistry', kind: 'topic' }));
const sourceMap = new Map();
const addSource = (list, url, label) => { if (!list.some(item => item.url === url)) list.push({ label, url }); sourceMap.set(url, { url, label, use: '仅供事实核对、物质身份确认与延伸阅读；中文题干、摘要和解析为独立编写，不整页复制。' }); };
const polymerNames = /聚乙烯|聚丙烯（|聚氯乙烯|聚苯乙烯|PET|PLA|PMMA|尼龙|聚碳酸酯|聚氨酯|PDMS|PTFE|ABS|聚丙烯酰胺|聚丙烯酸钠/;
function sourcesFor(record) {
  const refs = [], { name, group, variable } = record;
  if (!variable) addSource(refs, `https://pubchem.ncbi.nlm.nih.gov/compound/${identities[record.lookup].cid}`, `PubChem：${name}，CID ${identities[record.lookup].cid}（分子身份/式）`);
  if (variable && materialDetailSources[record.lookup]) { const [url, label] = materialDetailSources[record.lookup]; addSource(refs, url, label); }
  if (/甲醇$/.test(name)) addSource(refs, officialSources.methanol, 'CDC/NIOSH：甲醇暴露危害');
  if (/^乙二醇/.test(name)) addSource(refs, officialSources.ethyleneGlycol, 'WHO/IPCS：乙二醇物质与危害');
  if (name === '正己烷') addSource(refs, officialSources.hexane, 'WHO/ILO ICSC 0279：正己烷');
  if (/乙醚/.test(name)) addSource(refs, officialSources.ether, 'WHO/ILO ICSC 0355：乙醚');
  if (name === '苯') addSource(refs, officialSources.benzene, 'WHO/ILO ICSC 0015：苯');
  if (name === '甲醛') addSource(refs, officialSources.formaldehyde, 'WHO/IPCS：甲醛');
  if (/DMF/.test(name)) addSource(refs, officialSources.dmf, 'CDC/NIOSH：二甲基甲酰胺');
  if (/THF/.test(name)) addSource(refs, materialSources.thf, 'WHO/ILO ICSC 0578：四氢呋喃');
  if (/二氧六环/.test(name)) addSource(refs, materialSources.dioxane, 'WHO/ILO ICSC 0041：1,4-二氧六环');
  if (/三氯蔗糖|安赛蜜|阿斯巴甜|糖精/.test(name)) addSource(refs, officialSources.sweeteners, 'FDA：食品甜味剂的许可与使用边界（美国）');
  if (/谷氨酸钠/.test(name)) addSource(refs, officialSources.msg, 'FDA：谷氨酸钠问答');
  if (/木糖醇/.test(name)) addSource(refs, materialSources.xylitol, 'FDA：木糖醇对犬的中毒风险');
  if (/赤藓糖醇/.test(name)) addSource(refs, materialSources.erythritol, 'EFSA：赤藓糖醇再评估（2023）');
  if (/汽油|异辛烷|正庚烷/.test(name)) addSource(refs, officialSources.octane, '美国EIA：汽油辛烷值与参比物');
  if (/汽油/.test(name)) addSource(refs, officialSources.gasoline, '美国EIA：汽油是随用途改变的混合燃料');
  if (polymerNames.test(name) || /淀粉|纤维素|海藻酸钠|果胶/.test(name)) addSource(refs, materialSources.repeatUnit, 'IUPAC：结构重复单元不等于整链分子式');
  if (/PET|尼龙|聚氨酯/.test(name)) addSource(refs, materialSources.stepGrowth, 'OpenStax原创开放教材：逐步增长聚合物（事实核对）');
  if (/尼龙/.test(name)) addSource(refs, materialSources.nylon, 'OpenStax：聚酰胺与聚酯（事实核对）');
  if (/聚碳酸酯/.test(name)) addSource(refs, materialSources.polycarbonate, 'Covestro：PC具体牌号性质，不外推全部成品');
  if (/PLA/.test(name)) addSource(refs, materialSources.pla, 'NatureWorks：PLA原料、材料与用途健康安全资料');
  if (/PTFE/.test(name)) { addSource(refs, materialSources.ptfe, 'Chemours：PTFE聚合物性质与用途'); addSource(refs, materialSources.ptfeHeat, 'CDC/NIOSH：PTFE热分解暴露报告'); }
  if (/表活|十二烷|硬脂酸钠|洗洁精/.test(name)) addSource(refs, materialSources.surfactants, '美国EPA：表面活性剂结构与环境评价');
  if (/洗洁精/.test(name)) addSource(refs, materialSources.cleaning, '美国EPA：清洁配方中溶剂、表活和螯合组分的功能');
  if (group.id === 'food-biochemical' && !/甘氨酸|丙氨酸|赖氨酸|半胱氨酸|谷氨酸|葡萄糖|果糖|蔗糖|乳糖|麦芽糖|纤维素/.test(name)) addSource(refs, officialSources.foodRegulation, 'FDA：食品添加剂许可须针对具体用途核对，不能代替中国等地区现行标准');
  if (!refs.length) throw new Error(`Missing source refs: ${name}`);
  return refs;
}
const questions = records.map((record, i) => {
  const { name, formula, group, properties, reaction, uses, safety, variable } = record;
  const ids = new Set(['identity', 'reaction', 'safety']);
  if (/生活|清洁|食品|食用|包装|家用|糖|香料|护肤|个人护理|日用|瓶|餐具/.test(properties + uses + name)) ids.add('daily');
  if (/工业|化工|溶剂|树脂|加工|材料/.test(uses)) ids.add('industrial');
  if (/食品|食用|甜味|糖|淀粉|氨基酸|谷氨酸钠|酸味|甘油/.test(uses + name)) ids.add('food');
  if (group.id === 'hydrocarbon' || /汽油/.test(name)) ids.add('fuel');
  if (/溶剂/.test(uses)) ids.add('solvent');
  if (/醇|苯酚|苯二酚/.test(name)) ids.add('alcohol');
  if (/甲醛|乙醛|苯甲醛|丙酮|丁酮|环己酮/.test(name)) ids.add('carbonyl');
  if (/羧|脂肪酸|酸钠|酸钾|酸钙|柠檬酸|酒石酸/.test(properties + name)) ids.add('carboxylic');
  if (/酯|皂化/.test(name + reaction)) ids.add('ester');
  if (/葡萄糖|果糖|蔗糖|乳糖|麦芽糖|淀粉|纤维素|果胶|海藻酸钠|木糖醇|山梨糖醇|赤藓糖醇/.test(name)) ids.add('sugar');
  if (/氨基酸/.test(properties) || /甘氨酸|丙氨酸|谷氨酸|赖氨酸|半胱氨酸|阿斯巴甜/.test(name)) ids.add('amino');
  if (polymerNames.test(name) || /淀粉|纤维素|海藻酸钠|果胶/.test(name)) ids.add('polymer');
  if (/无唯一/.test(formula) || /苯磺酸钠/.test(name)) ids.add('mixture');
  if (/十二烷|硬脂酸钠|洗洁精/.test(name)) ids.add('surfactant');
  if (/异构|对映|构型|立体|位置不同/.test(properties + safety)) ids.add('isomer');
  if (/食品|食用|医疗|药用|食品接触/.test(uses + safety)) ids.add('regulation');
  const complexity = /半反应|配位|糖苷|官能团|立体|酰胺|聚合物|端基|共聚|交联|两性离子|多齿/.test(properties + reaction) ? 3 : 2;
  return {
    id: `CHEM-ORG-${String(i + 1).padStart(6, '0')}`, title: `${name}：性质、反应与用途`, type: 'short_answer',
    stemMarkdown: `**名称：${name}**\n\n**${variable ? '组成/重复单元' : '分子式/身份'}：${formula}**\n\n请说明其主要性质、一个有代表性的反应或变化机制、常见用途，以及与相似物质或实际商品的区别。若不存在单一分子式或统一反应方程，请解释原因。`,
    options: [], correctAnswers: [],
    answerMarkdown: `**${name}｜${formula}**\n\n**主要性质**：${properties}\n\n**代表性反应/机制**：${reaction}\n\n**常见用途**：${uses}`,
    explanationMarkdown: `### 身份与物性辨析\n${properties}\n\n### 反应条件、计量与适用范围\n${reaction}\n\n${/\[O\]/.test(reaction) ? '其中[O]表示氧化当量，不是氧化剂的真实分子式；不能把此符号代入试剂用量计算。\n\n' : ''}${ids.has('polymer') || /聚合|重复单元|缩聚/.test(reaction) ? '聚合物的重复式描述结构单元，实际分子还具有端基、链长分布及可能的支化或交联；示意反应不能直接当作有限分子的完整配方计量。\n\n' : ''}### 用途及常见误区\n${uses}\n\n${variable ? '本题描述的是材料族、混合物或重复组成。不能因为商品有一个通用名称，就给整种商品虚构唯一小分子式，也不能用示例小分子结构代替全部组成。' : '分子式给出元素计数，不一定唯一确定键连、立体构型、盐形式或水合状态。题目中的指定名称与结构说明必须一起保留；纯物质性质也不能直接外推到全部同名商品。'}\n\n### 暴露风险与使用边界\n${safety}\n\n### 自测与追问\n请把本题的用途与所依赖的性质一一对应，再说明改变浓度、纯度等级、pH、温度或材料配方中的哪一个因素会使结论不再成立。涉及食品、食品接触或专业制剂时，化学身份本身不能代替适用地区的现行许可和成品规格。\n\n### 内容与来源说明\n本卡为通识学习而独立编写；反应式是性质和计量示例，并非合成、提纯或使用操作指南。事实核对日期为2026-10-22。来源中的PubChem分子身份与材料检索用途已分别标注；开放教材只用于核对术语/机制，未复制正文、习题或图。`,
    difficulty: complexity === 3 ? 2 : 1, depth: complexity, frequency: 0,
    frequencyScope: '化学通识卡（不统计面试频次）', frequencyBasis: 'frequency=0表示未评估发生频率；不把生活常见程度冒充面试统计。',
    collection: 'general', status: 'pending', categoryIds: [`chem-org-cat-${group.id}`], tagIds: [...ids].map(id => `chem-org-${id}`), sourceRefs: sourcesFor(record),
    sourceDocument: null, sourceAnchor: null, createdAt: generatedAt, updatedAt: generatedAt
  };
});
const pack = {
  schemaVersion: 1, generatedAt,
  domains: [{ id: 'chemistry', name: '化学', description: '日常、工业、食品与材料中的化学物质、性质、反应和用途。', sortOrder: 5 }],
  categories, tags, questions,
  questionBanks: [{ id: 'bank-chemistry-organic-202610', name: '有机、食品与材料化学120卡', description: '常见烃、溶剂、羧酸酯、糖与食品组分、聚合物及生活配方；生成时待审核。', questionIds: questions.map(question => question.id) }],
  documents: [], papers: []
};
const output = `${JSON.stringify(pack, null, 2)}\n`;
const manifest = {
  id: 'chemistry-organic-202610', name: '有机、食品与材料化学通识卡', generatedAt, totalQuestions: questions.length, typeCounts: { short_answer: questions.length }, reviewStatus: 'pending', collection: 'general',
  output: 'data/content-packs/chemistry-organic.json', sha256: crypto.createHash('sha256').update(output).digest('hex'),
  groups: groups.map(group => ({ id: group.id, name: group.name, count: records.filter(record => record.group.id === group.id).length })),
  quality: { differentNames: new Set(records.map(record => record.name)).size, properties: questions.length, reactionOrMechanism: questions.length, uses: questions.length, explicitSafetyAndIdentityBoundaries: questions.length, molecularFormulaIndependentlyCheckedWithPubChem: records.filter(record => !record.variable).length, variableMaterialCards: records.filter(record => record.variable).length, duplicatePolicy: '独立120个命名条目；异构体、水合物和盐身份明确；医学活性药物不在本包重复收录。' },
  editorialBoundaries: ['材料重复式不等于整链分子式；混合配方无唯一分子式。', '无适用单一方程的胶束、溶胀、分相、共聚或老化采用机制和边界说明，不用燃烧反应凑数。', '涉及食品许可仅作有条件用途概述；美国FDA材料不替代中国等地区当前许可/限量。', '健康安全信息为危害识别，无疾病诊疗、给药或摄入剂量建议，无危险化学品制备/提纯流程。', '120条均由项目独立编写，不是商业字典或商业题库摘录；阅读来源不构成对第三方整页内容的再许可。'],
  frequencyPolicy: '0=未评估发生频率，非不常见；难度和深度独立标记。',
  identities: Object.fromEntries(records.filter(record => !record.variable).map(record => [record.lookup, identities[record.lookup]])),
  sources: [...sourceMap.values()],
  rebuild: 'node scripts/content/chemistry/chemistry-organic.mjs；重新核验PubChem身份时加 --refresh-identities（限速、重试，网络缓存位于.localtools/content-sources）。离线重建读取本manifest内已核验CID/分子式。',
  license: 'Project-authored educational summaries; factual identities and public primary sources are cited separately. No third-party prose/images copied.'
};
await fs.mkdir(path.join(root, 'data/content-packs'), { recursive: true });
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(path.join(root, 'data/content-packs/chemistry-organic.json'), output);
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ total: questions.length, molecularIdentities: manifest.quality.molecularFormulaIndependentlyCheckedWithPubChem, variableMaterialCards: manifest.quality.variableMaterialCards, groups: manifest.groups, sha256: manifest.sha256 }, null, 2));
