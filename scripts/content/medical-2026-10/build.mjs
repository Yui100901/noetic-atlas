/** Build source-backed pending medical learning cards without opening SQLite.
 * Run after prepare-modern-sources.mjs and fetch-sources.py. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { modernDrugs } from './modern-drugs.mjs';
import { medicalConcepts } from './concept-catalog.mjs';
import { GLOBAL_KNOWLEDGE_TAGS } from '../../../shared/questions/knowledge-tags.ts';

const ROOT = resolve(import.meta.dirname, '../../..'), CACHE = join(ROOT, 'data/content-cache/medical-2026-10');
const STAMP = '2026-10-26T13:00:00.000Z', ID = 'medical-expansion-20261026';
const json = async name => JSON.parse(await readFile(join(CACHE, name), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const [poly, formula, nhs, pharmacopoeia, oldPack] = await Promise.all([json('poly-records.json'), json('formula-records.json'), json('nhs-records.json'), json('pharmacopoeia-records.json'), readFile(join(ROOT, 'data/content-packs/pharmacology.json'), 'utf8').then(JSON.parse)]);
assert.equal(poly.errors.length, 0); assert.equal(formula.errors.length, 0); assert.equal(nhs.errors.length, 0);
const dict = new Map(); const conversionSources = [];
for (const file of ['TSCharacters.txt', 'TSPhrases.txt']) {
  const text = await readFile(join(CACHE, file), 'utf8'); assert.ok(text.length > 1000);
  for (const line of text.split(/\r?\n/)) { if (!line || line.startsWith('#') || !line.includes('\t')) continue; const [a, b] = line.split('\t'); dict.set(a, b.split(' ')[0]); }
  conversionSources.push({ file, sha256: sha(text), url: `https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/${file}`, license: 'Apache-2.0' });
}
const maxKey = Math.max(...[...dict.keys()].map(key => key.length));
function simplify(value = '') {
  let output = '';
  for (let index = 0; index < value.length;) {
    let found = false;
    for (let size = Math.min(maxKey, value.length - index); size > 0; size--) { const key = value.slice(index, index + size); if (dict.has(key)) { output += dict.get(key); index += size; found = true; break; } }
    if (!found) output += value[index++];
  }
  return output.normalize('NFKC').replace(/\uFEFF/g, '').trim();
}
const concise = value => simplify(value).replace(/\[\s*\d+(?:\s*[-,，]\s*\d+)*\s*\]/g, '').replace(/\s+/g, ' ').replace(/[。；;\s]+$/, '').trim();
const missing = value => !value || /^(?:暂未有资料|暂无资料|未有资料|无资料|-|无)$/.test(value);
const fields = row => Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [simplify(key), concise(value)]));
const aliases = new Map(Object.entries({ '蔪蛇': '蕲蛇', '粉葛根': '粉葛', '代赭石': '赭石', '北板蓝根': '板蓝根', '天门冬': '天冬', '麦门冬': '麦冬', '沙苑蒺藜': '沙苑子', '白僵蚕': '僵蚕', '木鼈子': '木鳖子', '胡麻仁': '黑芝麻', '橘皮': '陈皮', '番红花': '西红花', '黄耆': '黄芪', '黄蘗': '黄柏', '佛手柑': '佛手', '附子': '制附子', '栝楼根': '天花粉', '栝楼仁': '瓜蒌子', '鼈甲': '鳖甲' }));
const canonicalName = value => aliases.get(simplify(value)) || simplify(value);
const pharmacopoeiaByName = new Map(pharmacopoeia.records.map(row => [canonicalName(row.name), row]));
const pharmaRef = row => ref(`台湾中药典第四版：${row.name}（PDF第${row.cautionPage || row.functionPage}页）`, row.url+`#page=${row.cautionPage || row.functionPage}`);
const categoryMap = new Map(), tagMap = new Map(), questions = [], provenance = [], exclusions = [], merges = [];
const domain = oldPack.domains.find(item => item.id === 'medicine-pharmacy'); assert.ok(domain);
function category(id, name, parentId = null) { if (!categoryMap.has(id)) categoryMap.set(id, { id, domainId: domain.id, parentId, name, description: '医学知识学习；来源及适用范围见每题参考和内容包说明。', sortOrder: 230 + categoryMap.size }); return id; }
function tag(id, name, description = '', kind = 'topic') { if (!tagMap.has(id)) tagMap.set(id, { id, name, domainId: domain.id, kind, color: '#8D6A98', description }); return id; }
const tcmRoot = category('med26-traditional-root', '中国传统医学');
const herbRoot = category('med26-herbs-root', '中药材与饮片', tcmRoot);
const riskRoot = category('med26-herbs-toxic', '有毒药材与风险辨识', tcmRoot);
const formulaRoot = category('med26-formulas', '传统方剂与基准方', tcmRoot);
const tcmConceptRoot = category('med26-traditional-concepts', '中医基础概念', tcmRoot);
const modernRoot = category('med26-modern-root', '现代医学与药物');
const drugRoot = category('med26-modern-drugs', '现代常用药物', modernRoot);
const modernConceptRoot = category('med26-modern-concepts', '精准医学、诊断与临床研究', modernRoot);
const interactionRoot = category('med26-interactions', '配伍与风险辨析', tcmRoot);
tag('med26-tcm', '传统医学', '用于传统理论与经验的学习，不代表所有传统主治均已得到现代临床验证。');
tag('med26-materia', '药材与饮片'); tag('med26-formula', '传统方剂'); tag('med26-toxic', '有毒药材', '依条目传统毒性或已知毒性信息标记，不是过时标签。');
tag('med26-interaction', '配伍与相互作用'); tag('med26-modern', '现代医学'); tag('med26-pharmacology', '药理机制');
for (const oldId of ['med-pharm-safety', 'med-pharm-source-review']) { const old = oldPack.tags.find(item => item.id === oldId); assert.ok(old); tagMap.set(oldId, old); }
tagMap.set('method-concept', { ...GLOBAL_KNOWLEDGE_TAGS.find(item => item.id === 'method-concept') });
const ref = (label, url) => ({ label, url });
const CMRO = 'https://www.cmro.gov.hk/html/gb/useful_information/public_health/pamphlet/Adverse_Reactions_of_CM.html';
const PAIRS = 'https://amr.sz.gov.cn/attachment/0/755/755971/9772236.pdf';
const NCCIH_INTERACTIONS = 'https://www.nccih.nih.gov/health/providers/digest/herb-drug-interactions-science';
const regulated = new Map([
  ['羚羊角', { reason: '涉及受保护物种来源及贸易许可；不列入本批常用药材扩充，未将其表述为全球一律禁用。', url: 'https://www.afcd.gov.hk/tc_chi/conservation/con_end/tcm.html' }],
  ['紫河车', { reason: '历史药用及现代来源、伦理与地区监管问题需另外核对，不列入本批常用药材扩充。', url: 'https://dep.mohw.gov.tw/DOcMAP/cp-853-87294-108.html' }],
]);
const traditionalPairs = new Map();
function pair(a, b, kind) { for (const left of a) for (const right of b) { for (const [from, to] of [[left, right], [right, left]]) { const entries = traditionalPairs.get(from) || []; entries.push(`${kind}：${to}`); traditionalPairs.set(from, entries); } } }
pair(['甘草', '炙甘草'], ['海藻', '红大戟', '芫花'], '十八反');
pair(['制川乌', '制附子'], ['川贝母', '浙贝母', '平贝母', '瓜蒌', '天花粉', '半夏', '白蔹', '白及'], '十八反');
pair(['人参', '丹参', '南沙参', '北沙参', '玄参', '苦参', '细辛', '白芍', '赤芍'], ['藜芦'], '十八反');
pair(['巴豆'], ['牵牛子'], '十九畏'); pair(['丁香'], ['郁金'], '十九畏'); pair(['肉桂'], ['赤石脂'], '十九畏'); pair(['人参'], ['五灵脂'], '十九畏'); pair(['芒硝', '玄明粉'], ['三棱'], '十九畏');
const safety = new Map([
  ['甘草', { note: '甘草酸相关暴露可引起低钾、高血压和严重心律异常，长期或高暴露时尤其需关注', interaction: '与糖皮质激素等存在已报告相互作用；其他影响钾水平或心律的治疗也需核对', refs: [ref('NIH/NCCIH：甘草安全性', 'https://www.nccih.nih.gov/health/licorice-root')] }],
  ['炙甘草', { note: '炮制不能被理解为消除全部甘草酸相关风险；仍需关注低钾、血压及心律问题', interaction: '与糖皮质激素等治疗合用时须核对相互作用', refs: [ref('NIH/NCCIH：甘草安全性', 'https://www.nccih.nih.gov/health/licorice-root')] }],
  ['人参', { note: '可出现失眠等不良反应，血糖相关影响需关注', interaction: '与华法林等的临床研究结果并不一致，不能断言必然增强或削弱抗凝；其他潜在合用风险需具体核对', refs: [ref('NIH/NCCIH：人参', 'https://www.nccih.nih.gov/health/asian-ginseng'), ref('NIH/NCCIH：草药与药物相互作用证据', NCCIH_INTERACTIONS)] }],
  ['红参', { note: '红参属人参加工品，不能因加工而认定没有失眠或其他风险', interaction: '抗凝及降糖治疗等合用风险需核对；人参与华法林研究存在不一致，不能写成确定方向', refs: [ref('NIH/NCCIH：人参及证据边界', 'https://www.nccih.nih.gov/health/asian-ginseng'), ref('NIH/NCCIH：相互作用', NCCIH_INTERACTIONS)] }],
  ['西洋参', { note: '不同参类和提取物研究不能直接互相代替，合用药及血糖变化需关注', interaction: '不能把亚洲人参的全部结果直接套用于本品；与抗凝等治疗应按具体产品和证据核对', refs: [ref('NIH/NCCIH：参类相互作用与研究不确定性', NCCIH_INTERACTIONS)] }],
  ['银杏叶', { note: '可能增加部分人出血风险；叶提取物、整叶及种子不是同一种制剂', interaction: '抗凝或抗血小板治疗等合用时需关注出血风险，不能由单一研究推为所有制剂必然同效', refs: [ref('NIH/NCCIH：银杏', 'https://www.nccih.nih.gov/health/ginkgo')] }],
  ['麻黄', { note: '麻黄碱样成分可引起心率、血压及严重心血管风险；各地区对相关制剂或补充剂规定不同', interaction: '与拟交感药及部分影响心率、血压的药物合用需严格核对', refs: [ref('NIH/NCCIH：麻黄', 'https://www.nccih.nih.gov/health/ephedra')] }],
  ['制何首乌', { note: '何首乌及其制品存在肝损伤风险；有肝病史或与其他肝毒性药合用时尤其需关注', interaction: '其他可能损伤肝脏的药物或草药需特别核对，炮制不等于完全无肝毒性', refs: [ref('NIH/NIDDK LiverTox：何首乌', 'https://www.ncbi.nlm.nih.gov/books/NBK548795/')] }],
  ['制附子', { note: '乌头类生物碱可引起严重心律失常及神经毒性，炮制品仍有风险；孕妇禁用，阴虚阳盛者忌服', refs: [ref('香港卫生署：含乌头类生物碱中药材', 'https://www.cmro.gov.hk/html/gb/useful_information/public_health/pamphlet/The_safe_use_of_Chinese_medicines_containing_aconitum_alkaloids.html')] }],
  ['制川乌', { note: '乌头类生物碱可造成严重中毒及心律失常；孕妇禁用，阴虚阳盛者忌服', refs: [ref('香港卫生署：含乌头类生物碱中药材', 'https://www.cmro.gov.hk/html/gb/useful_information/public_health/pamphlet/The_safe_use_of_Chinese_medicines_containing_aconitum_alkaloids.html')] }],
  ['细辛', { note: '必须核对准确物种和药用部位；不能与其他马兜铃科植物或来源不明材料混用', refs: [ref('NIH/NCI：马兜铃酸的肾毒性和致癌风险', 'https://www.cancer.gov/about-cancer/causes-prevention/risk/substances/aristolochic-acids')] }],
  ['防己', { note: '须与广防己等同名异物区分；误用含马兜铃酸材料可导致严重肾损伤', refs: [ref('香港卫生署：同名异物与中药不良反应', CMRO)] }],
]);
function safeCaution(value) {
  if (missing(value)) return '';
  // Do not turn pharmacognosy notes into a cooking, dosing or processing guide.
  return value.split(/[。；;]/).map(item => item.trim()).filter(item => item && !/(?:先煎|后下|久煎|烊化|冲服|研末|煎服|包煎|煎汤|内服.*外用|用量)/.test(item)).join('；').slice(0, 240);
}
function base(id, title, stem, answer, explanation, categoryIds, tagIds, sources, concept) {
  const value = { id, title, type: 'short_answer', stemMarkdown: stem, answerMarkdown: answer, explanationMarkdown: explanation, options: [], correctAnswers: [], difficulty: 2, depth: 2, frequency: 0, frequencyScope: '', frequencyBasis: '未统计考试出现频率。', collection: 'general', status: 'pending', categoryIds, tagIds: [...new Set(tagIds)], sourceRefs: [...new Map(sources.map(item => [item.url, item])).values()], sourceDocument: null, sourceAnchor: null, createdAt: STAMP, updatedAt: STAMP, ...(concept ? { concept } : {}) };
  questions.push(value); return value;
}
const herbNames = new Set(); let missingHerbCautions = 0, missingHerbAdverse = 0, toxicHerbs = 0;
for (const row of poly.records) {
  const name = canonicalName(row.name);
  if (regulated.has(name)) { exclusions.push({ name, source: row.url, ...regulated.get(name) }); continue; }
  if (name === '滑石粉') { merges.push({ name, into: '滑石', reason: '同一原药材的粉末形态不另计一种常用药材。', source: row.url }); continue; }
  assert.ok(!herbNames.has(name), 'Duplicate herb '+name); herbNames.add(name);
  const f = fields(row), topicId = `med26-herb-${sha(f['药性分类']).slice(0, 10)}`, toxic = /有(?:小|大)?毒/.test(f['性味']);
  category(topicId, f['药性分类'], herbRoot); tag(topicId+'-topic', f['药性分类']); if (toxic) toxicHerbs++;
  const book = pharmacopoeiaByName.get(name), bookFields = book ? fields(book) : null;
  const caution = [...new Set([safeCaution(f['注意事项']), safeCaution(bookFields?.['注意事项'])].filter(Boolean))].join('；'), adverse = missing(f['不良反应']) ? '' : f['不良反应'];
  if (!caution) missingHerbCautions++; if (!adverse) missingHerbAdverse++;
  const override = safety.get(name), pairs = [...new Set(traditionalPairs.get(name) || [])];
  const explanations = [
    `**药用部位**：${f['药用部位']}。\n\n**传统性味**：${f['性味']}；**归经**：${f['归经']}。`,
    `**传统主治线索**：${f['主治']}。`,
    `**传统禁忌／注意**：${caution || '所核对条目未列明'}。`,
    override?.note ? `**重点安全信息**：${override.note}。` : adverse ? `**不良反应资料提示**：${adverse}。` : '',
    override?.interaction ? `**现代药物合用**：${override.interaction}。` : '',
    pairs.length ? `**传统配伍记录**：${pairs.join('；')}。这里记录传统规则，不把每个配对均视作已由现代临床试验证实。` : '',
  ].filter(Boolean).join('\n\n');
  const sources = [ref(`香港理工大学护理学院：${row.name}（药性与传统功用）`, row.url), ...(book ? [pharmaRef(book)] : []), ...(override?.refs || []), ...(pairs.length ? [ref('深圳地方标准资料性附录：十八反与十九畏目录', PAIRS)] : [])];
  base('MED26-HERB-'+sha(row.url).slice(0, 12).toUpperCase(), name, `${name}：传统药性、主要功效和用药风险有哪些？`, `**传统分类**：${f['药性分类']}。\n\n**功效要点**：${f['功效']}。`, explanations, [topicId, ...(toxic ? [riskRoot] : [])], ['med26-tcm', 'med26-materia', topicId+'-topic', 'med-pharm-safety', 'med-pharm-source-review', ...(pairs.length ? ['med26-interaction'] : []), ...(toxic ? ['med26-toxic'] : [])], sources);
  provenance.push({ questionId: questions.at(-1).id, name, kind: 'materia', url: row.url, sha256: row.sha256, cautionListed: !!caution, adverseListed: !!adverse, safetyOverride: !!override, traditionalToxicityListed: toxic, ...(book ? { pharmacopoeia: { name: book.name, pdfPage: book.pdfPage, functionPage: book.functionPage, cautionPage: book.cautionPage } } : {}) });
}
let extraPharmacopoeiaHerbs = 0;
const additionalToxic = new Set(['川乌', '草乌', '甘遂', '常山', '贯众', '猪牙皂', '皂荚']);
for (const row of pharmacopoeia.records) {
  const name = canonicalName(row.name); if (herbNames.has(name) || regulated.has(name)) continue;
  const f = fields(row), toxic = additionalToxic.has(name) || /有(?:小|大)?毒|毒性大/.test(f['性味']+' '+f['注意事项']);
  const topicId = `med26-herb-${sha(f['药性分类']).slice(0,10)}`; category(topicId, f['药性分类'], herbRoot); tag(topicId+'-topic', f['药性分类']);
  const caution = safeCaution(f['注意事项']); if (!caution) missingHerbCautions++; missingHerbAdverse++; if (toxic) toxicHerbs++;
  const override = name === '何首乌' ? safety.get('制何首乌') : safety.get(name), pairs = [...new Set(traditionalPairs.get(name)||[])];
  const body = [`**药典性味与归经**：${f['性味']}。`, `**药材拉丁名**：${row.latinHeader}。`, `**药典注意事项**：${caution || '所核对条目未列明'}。`, override?.note ? `**重点安全信息**：${override.note}。` : '', ...(pairs.length ? [`**传统配伍记录**：${pairs.join('；')}。传统规则与现代临床证据分别理解。`] : [])].filter(Boolean).join('\n\n');
  base('MED26-HERB-'+sha('THP4:'+name).slice(0,12).toUpperCase(), name, `${name}：传统药性、主要功效和用药风险有哪些？`, `**传统分类**：${f['药性分类']}。\n\n**功能要点**：${f['功效']}。`, body, [topicId, ...(toxic?[riskRoot]:[])], ['med26-tcm','med26-materia',topicId+'-topic','med-pharm-safety','med-pharm-source-review',...(toxic?['med26-toxic']:[])], [pharmaRef(row), ...(override?.refs||[]), ...(pairs.length?[ref('深圳地方标准资料性附录：十八反与十九畏目录',PAIRS)]:[])]);
  herbNames.add(name); extraPharmacopoeiaHerbs++;
  provenance.push({questionId:questions.at(-1).id,name,kind:'materia',sourceKind:'THP4',url:row.url,sha256:pharmacopoeia.source.sha256,cautionListed:!!caution,adverseListed:false,traditionalToxicityListed:toxic,pharmacopoeia:{name:row.name,pdfPage:row.pdfPage,functionPage:row.functionPage,cautionPage:row.cautionPage}});
}
const ingredientNames = value => [...new Set(value.split(/[、，,]/).map(item => item.trim().replace(/\([^)]*\)/g, '').replace(/[0-9０-９].*$/, '').replace(/\s+/g, '').replace(/[。;；].*$/, '')).filter(item => /^[\p{Script=Han}]{1,15}$/u.test(item)))];
let missingFormulaCautions = 0;
for (const row of formula.records) {
  const f = fields(row), name = f['方名'].replace(/《[丸散]》/g, '').replace(/\(丸\)/g, '').trim(), caution = safeCaution(f['注意事项']);
  const ingredients = ingredientNames(f['处方']); assert.ok(ingredients.length >= 2, 'Missing formula composition '+name);
  if (!caution) missingFormulaCautions++;
  // Official strike-through text was removed by the article parser.
  assert.ok(!ingredients.some(item => /穿山甲|虎骨|犀角|关木通|广防己|青木香/.test(item)), 'Restricted/withdrawn ingredient leaked '+name);
  const explanation = [`**传统适应证表述**：${f['适应症']}。`, `**组成药材名称**：${ingredients.join('、')}。`, `**出处**：${f['出典']}。`, `**注意事项**：${caution || '所核对条目未列明'}。`].join('\n\n');
  // Source item numbers contain a repeated 122; permanent page URL is unique.
  base('MED26-FORM-'+sha(row.url).slice(0, 12).toUpperCase(), name, `${name}：主要功效、传统适用线索及注意事项是什么？`, `**传统效能**：${f['效能']}。`, explanation, [formulaRoot], ['med26-tcm', 'med26-formula', 'med-pharm-safety', 'med-pharm-source-review'], [ref(`台湾卫福部中医药司基准方：${f['方名']}`, row.url)]);
  provenance.push({ questionId: questions.at(-1).id, name, kind: 'formula', sourceItemNumber: f['项次'], url: row.url, sha256: row.sha256, cautionListed: !!caution, sourceRegion: '台湾基准方；不表示内地同名中成药注册状态' });
}
const nhsByName = new Map(nhs.records.map(item => [item.name, item]));
for (const row of modernDrugs) {
  const verified = nhsByName.get(row.name); assert.ok(verified?.sources?.length, 'Unverified modern drug '+row.name);
  const topicId = `med26-drug-${sha(row.category).slice(0, 10)}`; category(topicId, row.category, drugRoot); tag(topicId+'-topic', row.category);
  base('MED26-DRUG-'+sha(row.name).slice(0, 12).toUpperCase(), row.name, `${row.name}：药理类别、主要用途及重点安全问题是什么？`, `**类别**：${row.category}。\n\n**作用机制**：${row.mechanism}。\n\n**用途范围**：${row.uses}。`, `**重点风险**：${row.caution}。\n\n**相互作用／合用注意**：${row.interactions}。`, [topicId], ['med26-modern', 'med26-pharmacology', 'med-pharm-safety', 'med-pharm-source-review', topicId+'-topic'], [...verified.sources.map(source => ref('NHS（英国）：'+source.title, source.url)), ...(row.extraSources || [])]);
  provenance.push({ questionId: questions.at(-1).id, name: row.name, kind: 'modern_drug', sources: verified.sources, sourceRegion: '主要英国NHS；非中国批准适应证目录' });
}
const modernRefs = [
  ref('NIH/NCI：医学及肿瘤术语词典', 'https://www.cancer.gov/publications/dictionaries/cancer-terms'),
  ref('NIH/NHGRI：遗传学术语', 'https://www.genome.gov/genetics-glossary'),
];
const tcmRefs = [ref('WHO：中医药国际标准术语（2022）', 'https://www.who.int/publications-detail-redirect/9789240042322')];
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
let reverseConcepts = 0;
for (const row of medicalConcepts) {
  const acceptedAnswers = [row.term, row.english], safe = acceptedAnswers.every(answer => !normalized(row.prompt).includes(normalized(answer)));
  const refs = row.sources || (row.group === 'traditional' ? tcmRefs : modernRefs);
  const concept = safe ? { term: row.term, meaningPrompt: row.prompt+'。', acceptedAnswers } : undefined; if (concept) reverseConcepts++;
  base('MED26-CONCEPT-'+sha(row.term).slice(0, 12).toUpperCase(), row.term, `${row.term}（${row.english}）是什么？`, row.prompt+'。', row.explanation, [row.group === 'traditional' ? tcmConceptRoot : modernConceptRoot], [row.group === 'traditional' ? 'med26-tcm' : 'med26-modern', 'method-concept'], refs, concept);
  provenance.push({ questionId: questions.at(-1).id, name: row.term, kind: row.group === 'traditional' ? 'tcm_concept' : 'modern_concept', reverseReady: !!concept });
}
let interactionQuestions = [];
try { ({ interactionQuestions } = await import('./interaction-questions.mjs')); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
for (const row of interactionQuestions) {
  const question = base('MED26-INTERACTION-'+row.key, row.title || row.stem.slice(0, 70), row.stem, row.answer, row.explanation, [interactionRoot], ['med26-tcm', 'med26-interaction', 'med-pharm-safety'], row.sources);
  question.type = row.type; question.options = row.options || []; question.correctAnswers = row.correctAnswers || []; question.difficulty = row.difficulty || 2;
  provenance.push({ questionId: question.id, kind: 'interaction_practice' });
}
assert.equal(new Set(questions.map(item => item.id)).size, questions.length);
assert.equal(new Set(questions.filter(item => item.id.startsWith('MED26-FORM')).map(item => item.title)).size, formula.records.length);
for (const question of questions) {
  assert.ok(question.answerMarkdown.trim() && question.explanationMarkdown.trim() && question.sourceRefs.length);
  assert.ok(!/回上一页|卫生福利部地址|浏览人数|建议最佳解析度|javascript:|<script/.test(JSON.stringify(question)), 'Navigation leaked '+question.title);
  assert.ok(question.categoryIds.every(id => categoryMap.has(id)) && question.tagIds.every(id => tagMap.has(id)), 'Broken taxonomy');
}
const pack = { schemaVersion: 1, generatedAt: STAMP, domains: [domain], categories: [...categoryMap.values()], tags: [...tagMap.values()], questions, documents: [], papers: [], assets: [] };
const counts = Object.fromEntries(['materia', 'formula', 'modern_drug', 'modern_concept', 'tcm_concept', 'interaction_practice'].map(kind => [kind, provenance.filter(item => item.kind === kind).length]));
const output = JSON.stringify(pack, null, 2)+'\n';
const report = { id: ID, title: '医学药学与中医药扩充：药材、方剂、现代药物与概念', generatedAt: STAMP, verifiedAt: '2026-10-26', questionStatus: 'pending', questions: questions.length, counts, reverseConcepts, toxicHerbs, extraPharmacopoeiaHerbs, missingHerbCautions, missingHerbAdverse, missingFormulaCautions, sha256: sha(output), bytes: Buffer.byteLength(output), reproduce: 'node scripts/content/medical-2026-10/build.mjs', exclusions, merges, sourceRecords: provenance, conversionSources, pharmacopoeiaSource: pharmacopoeia.source,
  scope: '药材/饮片、方剂、现代药物和概念分别统计。传统功用不等同现代临床证实疗效；条目未列禁忌不表示无禁忌。台湾基准方不等于中国内地所有同名中成药批准目录。',
  rights: '以规范名称和性质、功效等事实组织学习问答；不发布照片、原网页、长段教材论述或完整说明书。台湾卫福部资料依政府网站开放宣告及政府资料开放授权条款第1版注明出处使用。PolyU原站表达及其他第三方资料保留原权利，不将其整库声明为开放许可。简繁转换使用OpenCC Apache-2.0字典。',
  notices: ['本批未由医学专家逐题审定，所有新题待用户审核。', '不提供剂量、个体处方、炮制或解毒操作。', '参考资料中的传统配伍规则与现代人体研究证据区分记录。'],
  primaryReferences: [ref('台湾卫福部：政府网站资料开放宣告', 'https://www.mohw.gov.tw/cp-81-155-1.html'), ref('PolyU：版权声明', 'https://herbaltcm.sn.polyu.edu.hk/tc/copyright'), ref('WHO：传统医学安全与证据', 'https://www.who.int/news-room/questions-and-answers/item/traditional-medicine'), ref('香港卫生署：中药不良反应', CMRO)],
};
await mkdir(join(ROOT, 'data/content-packs'), { recursive: true }); await mkdir(join(ROOT, 'data/content-sources'), { recursive: true }); await mkdir(join(ROOT, 'test-results/medical-expansion'), { recursive: true });
await writeFile(join(ROOT, 'data/content-packs', ID+'.json'), output);
await writeFile(join(ROOT, 'data/content-sources', ID+'.json'), JSON.stringify(report, null, 2)+'\n');
await writeFile(join(ROOT, 'test-results/medical-expansion/build-report.json'), JSON.stringify({ ...report, sourceRecords: undefined }, null, 2)+'\n');
console.log(JSON.stringify({ id: ID, questions: questions.length, counts, reverseConcepts, toxicHerbs, missingHerbCautions, missingFormulaCautions, excluded: exclusions.length, merged: merges.length, sha256: report.sha256 }, null, 2));
