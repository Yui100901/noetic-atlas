import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export const STAMP = '2026-10-24T00:00:00.000Z';
export const ROOT = resolve(import.meta.dirname, '../../..');
export const sources = {
  earth: { label: 'NASA：地球事实与地球系统', url: 'https://science.nasa.gov/earth/facts/' },
  seasons: { label: 'NASA：四季形成原因', url: 'https://spaceplace.nasa.gov/seasons/en/' },
  geodesy: { label: 'NOAA：大地测量、椭球与大地水准面', url: 'https://oceanservice.noaa.gov/facts/geodesy.html' },
  maps: { label: 'USGS：地形图与地理空间资料', url: 'https://www.usgs.gov/programs/national-geospatial-program/topographic-maps' },
  plates: { label: 'USGS：板块运动与边界', url: 'https://pubs.usgs.gov/gip/dynamic/understanding.html' },
  climate: { label: 'NOAA：天气、大气和气候教学资源', url: 'https://www.noaa.gov/education/resource-collections' },
  coriolis: { label: 'NOAA：科里奥利效应与洋流', url: 'https://oceanservice.noaa.gov/education/tutorial_currents/04currents1.html' },
  enso: { label: 'NOAA：厄尔尼诺与拉尼娜', url: 'https://www.noaa.gov/education/resource-collections/weather-atmosphere/el-nino' },
  water: { label: 'USGS：水循环', url: 'https://www.usgs.gov/water-science-school/water-cycle' },
  basin: { label: 'USGS：流域与分水岭', url: 'https://www.usgs.gov/water-science-school/science/watersheds-and-drainage-basins' },
  aquifer: { label: 'USGS：含水层与地下水', url: 'https://www.usgs.gov/water-science-school/science/aquifers-and-groundwater' },
  population: { label: '联合国人口司：人口与城市术语', url: 'https://population.un.org/wup/glossary-demographic-terms' },
  land: { label: 'FAO：土地覆盖与土地利用', url: 'https://www.fao.org/geospatial/our-focus/' },
  agriculture: { label: 'FAO：农业普查与土地利用分类', url: 'https://www.fao.org/4/a0135e/A0135E07.htm' },
  hdi: { label: 'UNDP：人类发展指数的维度与边界', url: 'https://hdr.undp.org/data-center/human-development-index' },
  si: { label: 'BIPM：《国际单位制手册》第9版，2026更新入口', url: 'https://www.bipm.org/en/publications/si-brochure' },
  constants: { label: 'BIPM：SI定义常量', url: 'https://www.bipm.org/en/measurement-units/si-defining-constants' },
  nist: { label: 'NIST：国际单位制单位', url: 'https://www.nist.gov/pml/owm/metric-si/si-units' },
  mechanics: { label: 'OpenStax：大学物理第一卷，原理核验索引', url: 'https://openstax.org/books/university-physics-volume-1/pages/index' },
  newton: { label: 'OpenStax：牛顿第二定律，原理核验', url: 'https://openstax.org/books/university-physics-volume-1/pages/5-3-newtons-second-law' },
  thermal: { label: 'OpenStax：大学物理第二卷，热学原理核验', url: 'https://openstax.org/books/university-physics-volume-2/pages/1-introduction' },
  electromagnetic: { label: 'OpenStax：大学物理第二卷，电磁学原理核验索引', url: 'https://openstax.org/books/university-physics-volume-2/pages/index' },
  waves: { label: 'OpenStax：大学物理第三卷，光学与现代物理原理核验索引', url: 'https://openstax.org/books/university-physics-volume-3/pages/index' },
};
const methodTags = [
  { id: 'method-concept', name: '概念题', domainId: null, kind: 'method', color: '#856142', description: '解释定义、基本原理与适用边界' },
  { id: 'method-application', name: '应用题', domainId: null, kind: 'method', color: '#856142', description: '把知识用于具体场景与实践' },
];

/** Catalog content is independently authored; references verify factual claims,
 * and do not grant a new licence to the referenced websites or textbooks. */
export function createFoundationPack({ id, title, domain, prefix, groups, concepts, objectives }) {
  const categories = groups.map(([key, name], sortOrder) => ({ id: `${id}-${key}`, domainId: domain.id, parentId: null, name, description: `${name}的概念、术语、条件与基础练习。`, sortOrder }));
  const tags = [...methodTags, ...groups.map(([key, name]) => ({ id: `${id}-topic-${key}`, name, domainId: domain.id, kind: 'topic', color: '#476e89', description: `${domain.name} · ${name}` }))];
  const groupKeys = new Set(groups.map(([key]) => key));
  const seen = new Set();
  const build = (key, group, type, title, stemMarkdown, answerMarkdown, explanationMarkdown, extra, sourceKeys, difficulty = 1, depth = 1) => {
    if (!groupKeys.has(group) || seen.has(key)) throw new Error(`Invalid or duplicate catalog row: ${id}/${key}`);
    seen.add(key);
    const sourceRefs = [...new Set(sourceKeys)].map(source => { if (!sources[source]) throw new Error('Unknown source ' + source); return sources[source]; });
    return { id: `${prefix}-${key}`, title, type, stemMarkdown, answerMarkdown, explanationMarkdown, options: [], correctAnswers: [], difficulty, depth, frequency: 0, frequencyScope: '学科基础学习；未统计考试出现频率', frequencyBasis: '按知识结构整理，不代表实际考试命中率。', collection: 'general', status: 'pending', categoryIds: [`${id}-${group}`], tagIds: [type === 'short_answer' ? 'method-concept' : 'method-application', `${id}-topic-${group}`], sourceRefs, sourceDocument: null, sourceAnchor: null, createdAt: STAMP, updatedAt: STAMP, ...extra };
  };
  const questions = concepts.map(([key, group, term, english, definition, example, boundary, sourceKeys, difficulty = 1, depth = 2]) => build(`TERM-${key}`, group, 'short_answer', `${term}（${english}）`, `解释“${term}”的含义，并说明一个实例或应用条件。`, definition, `### 概念与实例\n\n${example}\n\n### 辨析与适用边界\n\n${boundary}`, {}, sourceKeys, difficulty, depth));
  for (const row of objectives) {
    const { key, group, type, stem, options = [], correct = [], explanation, sources: sourceKeys, answers, caseSensitive = false, difficulty = 1, depth = 1 } = row;
    if (!explanation?.trim()) throw new Error('Missing explanation ' + key);
    if (type === 'true_false') {
      const yes = correct[0] === 'true';
      questions.push(build(key, group, type, stem, stem, yes ? '正确。' : '错误。', explanation, { correctAnswers: [yes ? 'true' : 'false'] }, sourceKeys, difficulty, depth));
    } else if (type === 'fill_blank') {
      questions.push(build(key, group, type, stem, stem, answers.join(' / '), explanation, { blanks: [{ id: 'answer', label: '填写答案', answers, caseSensitive, trim: true }] }, sourceKeys, difficulty, depth));
    } else {
      const opts = options.map(([text], index) => ({ key: String.fromCharCode(65 + index), text }));
      if (!correct.length || correct.some(value => !opts.some(option => option.key === value))) throw new Error('Invalid objective answer ' + key);
      const detail = options.map(([text, reason], index) => `- **${String.fromCharCode(65 + index)}．${text}**：${reason}`).join('\n');
      questions.push(build(key, group, type, stem, stem, `${correct.join('、')}。`, `${explanation}\n\n${detail}`, { options: opts, correctAnswers: correct }, sourceKeys, difficulty, depth));
    }
  }
  return { schemaVersion: 1, generatedAt: STAMP, domains: [domain], categories, tags, questions, documents: [], papers: [], assets: [], questionBanks: [] };
}

export async function saveFoundationPack(options) {
  const pack = createFoundationPack(options), serialized = JSON.stringify(pack, null, 2) + '\n';
  const typeCounts = {};
  for (const q of pack.questions) typeCounts[q.type] = (typeCounts[q.type] || 0) + 1;
  const references = [...new Map(pack.questions.flatMap(q => q.sourceRefs).map(source => [source.url, source])).values()];
  const manifest = { id: options.id, title: options.title, generatedAt: STAMP, questions: pack.questions.length, typeCounts, reviewStatus: 'pending', collection: 'general', output: `data/content-packs/${options.id}.json`, sha256: createHash('sha256').update(serialized).digest('hex'), sourcePolicy: '题干、中文定义、情境和选项解析为本项目独立编写的科学事实摘要；所列官方资料及教材仅用于核验与延伸阅读。未复制来源正文、原题或图片，来源内容仍适用各自权利与使用条款，不宣称整书或网站内容可无限制再分发。', sources: references };
  await mkdir(join(ROOT, 'data/content-packs'), { recursive: true });
  await mkdir(join(ROOT, 'data/content-sources'), { recursive: true });
  await writeFile(join(ROOT, 'data/content-packs', options.id + '.json'), serialized);
  await writeFile(join(ROOT, 'data/content-sources', options.id + '.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export const single = (key, group, stem, options, correct, explanation, sourceKeys, difficulty = 1) => ({ key, group, type: 'single_choice', stem, options, correct: [correct], explanation, sources: sourceKeys, difficulty });
export const multi = (key, group, stem, options, correct, explanation, sourceKeys, difficulty = 1) => ({ key, group, type: 'multiple_choice', stem, options, correct, explanation, sources: sourceKeys, difficulty });
export const judge = (key, group, stem, correct, explanation, sourceKeys, difficulty = 1) => ({ key, group, type: 'true_false', stem, correct: [String(correct)], explanation, sources: sourceKeys, difficulty });
export const blank = (key, group, stem, answers, explanation, sourceKeys, caseSensitive = false) => ({ key, group, type: 'fill_blank', stem, answers, explanation, sources: sourceKeys, caseSensitive });
