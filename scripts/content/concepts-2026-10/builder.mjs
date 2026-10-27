/** Independently authored conceptual summaries. No working-database writes. */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { conceptPromptIsSafe } from '../../../shared/questions/concept.ts';
import { existingPrompts } from './existing-prompts.mjs';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const STAMP = '2026-10-26T12:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
export const sources = {
  cs: ['计算机科学基础：NIST算法与数据结构词典', 'https://xlinux.nist.gov/dads/'],
  go: ['Go官方：语言规范与内存模型', 'https://go.dev/ref/mem'],
  gogc: ['Go官方：垃圾回收指南', 'https://go.dev/doc/gc-guide'],
  rust: ['Rust官方：Rustonomicon', 'https://doc.rust-lang.org/nomicon/'],
  pg: ['PostgreSQL官方：执行计划与EXPLAIN', 'https://www.postgresql.org/docs/current/using-explain.html'],
  pgindex: ['PostgreSQL官方：索引类型、部分索引和覆盖扫描', 'https://www.postgresql.org/docs/current/indexes.html'],
  pgwal: ['PostgreSQL官方：预写日志与恢复', 'https://www.postgresql.org/docs/current/wal-intro.html'],
  pgrep: ['PostgreSQL官方：逻辑复制', 'https://www.postgresql.org/docs/current/logical-replication.html'],
  py: ['Python官方：asyncio任务与取消', 'https://docs.python.org/3/library/asyncio-task.html'],
  http: ['IETF：HTTP语义 RFC 9110', 'https://www.rfc-editor.org/rfc/rfc9110.html'],
  sec: ['NIST：网络安全术语', 'https://csrc.nist.gov/glossary'],
  queue: ['RabbitMQ官方：死信处理', 'https://www.rabbitmq.com/docs/dlx'],
  delay: ['RabbitMQ官方：消息存活时间与过期', 'https://www.rabbitmq.com/docs/ttl'],
  fencing: ['Martin Kleppmann：分布式锁与栅栏令牌的原理分析', 'https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html'],
  idem: ['Stripe官方：幂等请求与请求参数一致性', 'https://docs.stripe.com/api/idempotent_requests'],
  ai: ['Google机器学习速成课程：术语表', 'https://developers.google.com/machine-learning/glossary'],
  econ: ['OpenStax：经济学原理3e索引及各章', 'https://openstax.org/books/principles-economics-3e/pages/index'],
  game: ['MIT公开课程：博弈论的经济应用讲义', 'https://ocw.mit.edu/courses/14-12-economic-applications-of-game-theory-fall-2025/lists/lecture-notes/'],
  causal: ['世界银行：影响评估实践，工具变量／断点／双重差分', 'https://www.worldbank.org/en/programs/sief-trust-fund/publication/impact-evaluation-in-practice'],
  psych: ['OpenStax：心理学2e索引及各章', 'https://openstax.org/books/psychology-2e/pages/index'],
  water: ['USGS：水科学术语与水循环', 'https://www.usgs.gov/water-science-school/science/water-science-glossary'],
  geo: ['USGS：地球科学教学资源', 'https://www.usgs.gov/programs/science-education/science/science-topics'],
  climate: ['NOAA：天气与气候教学资源', 'https://www.noaa.gov/education/resource-collections/weather-atmosphere'],
  pop: ['联合国人口司：世界人口展望', 'https://www.un.org/development/desa/pd/data/world-population-prospects'],
  land: ['FAO：土地资源与可持续管理', 'https://www.fao.org/land-water/land/en/'],
  physics1: ['OpenStax：大学物理第一卷索引及各章', 'https://openstax.org/books/university-physics-volume-1/pages/index'],
  physics2: ['OpenStax：大学物理第二卷索引及各章', 'https://openstax.org/books/university-physics-volume-2/pages/index'],
  physics3: ['OpenStax：大学物理第三卷索引及各章', 'https://openstax.org/books/university-physics-volume-3/pages/index'],
  chemistry: ['OpenStax：化学2e索引及各章', 'https://openstax.org/books/chemistry-2e/pages/index'],
  iupac: ['IUPAC：Gold Book化学术语', 'https://goldbook.iupac.org/'],
  zh: ['教育部：重編國語辭典修訂本', 'https://dict.revised.moe.edu.tw/'],
  en: ['British Council：英语语法参考', 'https://learnenglish.britishcouncil.org/free-resources/grammar/english-grammar-reference'],
  ja: ['东京外国语大学：日语文法模块', 'https://www.coelang.tufs.ac.jp/mt/ja/gmod/'],
  drive: ['NHTSA：车辆安全与驾驶辅助技术', 'https://www.nhtsa.gov/vehicle-safety/driver-assistance-technologies'],
  tire: ['NHTSA：轮胎安全', 'https://www.nhtsa.gov/vehicle-safety/tires'],
};
const sourceOverrides = {
  '内存回收屏障': 'gogc', '安全点': 'gogc', '虚假共享': 'go,rust',
  '覆盖索引': 'pgindex', '部分索引': 'pgindex', '表达式索引': 'pgindex', '索引膨胀': 'pgindex', '可见性映射': 'pgindex',
  '检查点': 'pgwal', '重做日志': 'pgwal', '逻辑复制': 'pgrep',
  '消息毒丸': 'queue', '死信队列': 'queue', '延迟队列': 'delay,queue', '栅栏令牌': 'fencing', '幂等键': 'idem,http',
  '占优策略': 'game', '子博弈精炼均衡': 'game', '承诺装置': 'game,econ', '激励相容': 'game', '参与约束': 'game',
  '内生性': 'causal', '工具变量': 'causal', '双重差分': 'causal', '断点回归': 'causal',
};
const normal = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/^术语[：:]\s*/, '').split(/[（(]/u)[0].split(' · ')[0].replace(/[\s“”"'。:：]/g, '').trim();
export async function inventory() {
  const packs = [], questions = new Map(), categories = new Map(), domains = new Map(), tags = new Map(), filesById = new Map();
  const seed = JSON.parse(await readFile(join(ROOT, 'data/seed.json'), 'utf8'));
  for (const domain of seed.domains || []) domains.set(domain.id, domain);
  for (const category of seed.categories || []) categories.set(category.id, category);
  for (const tag of seed.tags || []) tags.set(tag.id, tag);
  for (const question of seed.questions || []) { questions.set(question.id, question); filesById.set(question.id, ['../seed.json']); }
  for (const name of (await readdir(join(ROOT, 'data/content-packs'))).filter(name => name.endsWith('.json') && !name.startsWith('concepts-deepening-202610-')).sort()) {
    const pack = JSON.parse(await readFile(join(ROOT, 'data/content-packs', name), 'utf8')); packs.push({ name, pack });
    for (const domain of pack.domains || []) domains.set(domain.id, domain);
    for (const category of pack.categories || []) categories.set(category.id, category);
    for (const tag of pack.tags || []) tags.set(tag.id, tag);
    for (const question of pack.questions || []) {
      if (!questions.has(question.id)) questions.set(question.id, question);
      const names = filesById.get(question.id) || []; names.push(name); filesById.set(question.id, names);
    }
  }
  return { packs, questions, categories, domains, tags, filesById };
}
export const row = (group, term, meaningPrompt, distinction, source = '', aliases = []) => ({ group, term, meaningPrompt, distinction, source, aliases });
export const list = (group, text, source = '') => text.trim().split(/\r?\n/).filter(line => line.trim()).map(line => {
  const fields = line.split('|').map(value => value.trim());
  if (fields.length < 3 || fields.some(value => !value)) throw new Error('Incomplete concept line '+line);
  return row(group, fields[0], fields[1], fields[2], source, fields[3] ? fields[3].split(' / ') : []);
});

export async function buildConceptPacks(catalogs) {
  const existing = await inventory(), reports = [], skipped = [];
  const domainNames = new Map();
  for (const question of existing.questions.values()) {
    for (const domain of new Set(question.categoryIds.map(id => existing.categories.get(id)?.domainId).filter(Boolean))) {
      const names = domainNames.get(domain) || new Set(); names.add(normal(question.title)); domainNames.set(domain, names);
    }
  }
  for (const catalog of catalogs) {
    const domain = existing.domains.get(catalog.domainId); if (!domain) throw new Error('Unknown domain '+catalog.domainId);
    const id = `concepts-deepening-202610-${catalog.key}`, seen = new Set(), questions = [];
    const categories = Object.entries(catalog.groups).map(([key, value], index) => ({ id: `${id}-${key}`, domainId: domain.id, parentId: null, name: value.name, description: value.description || '重要概念、独立短定义与适用边界；支持双向回忆。', sortOrder: 220 + index }));
    const tags = [existing.tags.get('method-concept'), existing.tags.get('method-terminology'), ...categories.map(category => ({ id: `${category.id}-topic`, name: category.name, domainId: domain.id, kind: 'topic', color: '#52758A', description: `${domain.name}：${category.name}` }))].filter(Boolean);
    for (const item of catalog.rows) {
      const term = item.term.trim(), name = normal(term);
      if (seen.has(name)) throw new Error('Duplicate newly authored term '+catalog.key+'/'+term); seen.add(name);
      if (domainNames.get(domain.id)?.has(name)) { skipped.push({ domainId: domain.id, term, reason: '已有同名概念，保留原ID并进入元数据整理范围' }); continue; }
      const concept = { term, meaningPrompt: item.meaningPrompt.trim(), acceptedAnswers: [...new Set([term, ...item.aliases])].filter(Boolean) };
      if (!conceptPromptIsSafe(concept)) throw new Error('Unsafe reverse prompt '+catalog.key+'/'+term);
      const group = catalog.groups[item.group]; if (!group) throw new Error('Unknown group '+item.group);
      const keys = (item.source || sourceOverrides[term] || group.source).split(',');
      const sourceRefs = keys.map(key => { if (!sources[key]) throw new Error('Unknown source '+key); const [label, url] = sources[key]; return { label, url }; });
      questions.push({ id: `CON26-${catalog.key.toUpperCase()}-${digest(term).slice(0, 12)}`, title: term, type: 'short_answer', stemMarkdown: term,
        answerMarkdown: concept.meaningPrompt + '。', explanationMarkdown: `### 辨析与应用\n\n${item.distinction}`,
        concept, options: [], correctAnswers: [], difficulty: 2, depth: 2, frequency: 0, frequencyScope: '基础学科重要概念；未统计考试出现概率', frequencyBasis: '按公开教材及官方参考的知识结构选编，不是试题命中率统计。',
        collection: 'general', status: 'pending', categoryIds: [`${id}-${item.group}`], tagIds: ['method-concept', ...(existing.tags.has('method-terminology') ? ['method-terminology'] : []), `${id}-${item.group}-topic`], sourceRefs, sourceDocument: null, sourceAnchor: null, createdAt: STAMP, updatedAt: STAMP });
    }
    if (!questions.length) continue;
    const pack = { schemaVersion: 1, generatedAt: STAMP, domains: [domain], categories, tags, questions, documents: [], papers: [], assets: [], questionBanks: [] };
    const serialized = JSON.stringify(pack, null, 2) + '\n', report = { id, domainId: domain.id, title: `${domain.name}重要概念补充`, questions: questions.length, inputRows: catalog.rows.length, reviewStatus: 'pending', generatedAt: STAMP, output: `data/content-packs/${id}.json`, sha256: digest(serialized), sourcePolicy: '概念和中文定义、辨析为独立编写的基础事实摘要；链接用于核验和延伸阅读，不复制来源原题、图表或大段正文。每张卡的短定义单独撰写并排除概念主词及可接受答案，供描述→概念回忆。', sources: [...new Map(questions.flatMap(q => q.sourceRefs).map(source => [source.url, source])).values()] };
    await mkdir(join(ROOT, 'data/content-packs'), { recursive: true }); await mkdir(join(ROOT, 'data/content-sources'), { recursive: true });
    await writeFile(join(ROOT, 'data/content-packs', id + '.json'), serialized); await writeFile(join(ROOT, 'data/content-sources', id + '.json'), JSON.stringify(report, null, 2) + '\n'); reports.push(report);
  }
  return { reports, skipped, questions: reports.reduce((sum, row) => sum + row.questions, 0) };
}

/** Conservative source-only plan. Root applies metadata to matching live IDs;
 * no approval, text, source, history or study record is changed by this file. */
export async function planExistingConcepts() {
  const existing = await inventory(), patches = [], excluded = [];
  for (const question of existing.questions.values()) {
    if (question.type !== 'short_answer' || question.vocabulary || question.concept) continue;
    const ids = question.categoryIds.map(id => existing.categories.get(id)?.domainId);
    if (ids.includes('medicine-pharmacy')) continue;
    const title = question.title.replace(/^术语[：:]\s*/, '');
    const explicit = question.title.startsWith('术语：') || /\(.*\)|（.*）/.test(title) && /TERM-/.test(question.id) || /^(?:ECO|PSY)-FND-SA-/.test(question.id);
    if (!explicit) continue;
    const term = title.split(/[（(]/)[0].split(' · ')[0].trim();
    if (term.length < 2 || term.length > 40 || /[？?；;：:，,、/]|与|及|怎样|如何|为什么/.test(term)) { excluded.push({ id: question.id, title: question.title, reason: '非单一明确术语' }); continue; }
    const definition = question.answerMarkdown.replace(/^\*\*概念定义\*\*[：:]\s*/, '').replace(/[*`#]/g, '').trim();
    const manuallyDefined = ids.map(domainId => existingPrompts[domainId]?.[term]).find(Boolean);
    if (/^(?:ECO|PSY)-FND-SA-/.test(question.id) && !manuallyDefined) { excluded.push({ id: question.id, title: question.title, reason: '场景或研究案例保留原题，未机械转为反向术语卡' }); continue; }
    let prompt = manuallyDefined || definition.split(/(?<=[。！？])/u)[0].replace(/[。！？]$/, '').trim();
    for (const lead of [`${term}是指`, `${term}指的是`, `${term}是`, `${term}指`, `${term}表示`]) if (prompt.startsWith(lead)) { prompt = prompt.slice(lead.length).trim(); break; }
    const concept = { term, meaningPrompt: prompt, acceptedAnswers: [term] };
    if (prompt.length < 10 || prompt.length > 170 || !conceptPromptIsSafe(concept)) { excluded.push({ id: question.id, title: question.title, reason: '未得到可靠且不泄词的独立短定义' }); continue; }
    const identity = [question.id, question.title, question.type, question.stemMarkdown, question.answerMarkdown, question.explanationMarkdown];
    patches.push({ id: question.id, concept, sourceFingerprint: digest(JSON.stringify(identity)), sourceFiles: existing.filesById.get(question.id), domainIds: [...new Set(ids)].filter(Boolean) });
  }
  const output = { format: 'noetic-atlas-concept-supplement', schemaVersion: 1, generatedAt: STAMP, questions: patches.map(({ id, concept, sourceFingerprint }) => ({ id, concept, sourceFingerprint })) };
  const audit = { generatedAt: STAMP, policy: '仅为明确单一术语和无泄词短定义补concept元数据；不改ID、原答案、解析、审核状态及学习记录。已有词汇、药物身份卡、问句/场景/多概念辨析不强制反转。源文件哈希用于检测实际库文字是否已修改。', existingQuestions: existing.questions.size, questions: patches, excluded };
  await mkdir(join(ROOT, 'data/content-sources'), { recursive: true }); await writeFile(join(ROOT, 'data/content-sources/concept-metadata-plan-20261026.json'), JSON.stringify(output, null, 2) + '\n');
  await writeFile(join(ROOT, 'data/content-sources/concept-metadata-audit-20261026.json'), JSON.stringify(audit, null, 2) + '\n');
  return { count: patches.length, excluded: excluded.length, byDomain: Object.fromEntries([...existing.domains.keys()].map(id => [id, patches.filter(row => row.domainIds.includes(id)).length])) };
}
