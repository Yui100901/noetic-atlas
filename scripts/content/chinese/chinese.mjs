import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = path.join(root, '.localtools/content-sources/chinese-wiktionary');
const indexUrl = 'https://kaikki.org/zhwiktionary/%E6%BC%A2%E8%AA%9E/categories-other/ES/%E6%BC%A2%E8%AA%9E%E6%88%90%E8%AA%9E/index.html';
const generatedAt = '2026-10-22T00:00:00.000Z';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const offline = process.argv.includes('--offline');
await fs.mkdir(cache, { recursive: true });

async function cached(url, file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (offline) throw new Error(`Missing cached source: ${path.basename(file)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'NoeticAtlasContentBuilder/1.0 (Wiktionary educational reuse; cache-first)' } });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const text = await response.text();
      if (!text.trim()) throw new Error(`Empty source: ${url}`);
      await fs.writeFile(file, text);
      return text;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}

const index = await cached(indexUrl, path.join(cache, 'index.html'));
const wordUrls = [...new Set([...index.matchAll(/href="([^"]+\/meaning\/[^"<>]+\.html)"/g)].map(match => new URL(match[1], indexUrl).href.replace(/\.html$/, '.jsonl')))];
if (wordUrls.length < 1000) throw new Error(`Unexpected idiom index: ${wordUrls.length} entries`);
const raw = new Array(wordUrls.length);
let next = 0;
let completed = 0;
const failures = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < wordUrls.length) {
    const i = next++;
    const url = wordUrls[i];
    try {
      const text = await cached(url, path.join(cache, `${hash(url)}.jsonl`));
      raw[i] = { url, sha256: hash(text), entries: text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) };
    } catch (error) { failures.push({ url, error: String(error.message) }); }
    completed++;
    if (completed % 250 === 0) console.log(`Chinese idioms: ${completed}/${wordUrls.length}, failures ${failures.length}`);
  }
}));

// Confirm script aliases against an independently maintained conversion table.
// A source form can contain an editorial error (e.g. a different idiom), so it
// must not be accepted merely because it is tagged Simplified-Chinese.
const openccUrl = 'https://registry.npmjs.org/opencc-js/-/opencc-js-1.4.2.tgz';
const openccIntegrity = 'EdcspgdROiCCZDM+jZR6Pa670xW+EW2QhctPBQ8gRjg6lrx4IHEl+2s+kt5izk/TkxVRgdWuFgaGkaEdIUfdaw==';
const openccCache = path.join(cache, 'opencc-js-1.4.2.tgz');
let openccArchive;
try { openccArchive = await fs.readFile(openccCache); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (offline) throw new Error('Missing cached OpenCC conversion table');
  const response = await fetch(openccUrl, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`OpenCC source ${response.status}`);
  openccArchive = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(openccCache, openccArchive);
}
if (crypto.createHash('sha512').update(openccArchive).digest('base64') !== openccIntegrity) throw new Error('OpenCC npm integrity mismatch');
const tar = gunzipSync(openccArchive);
const conversionModules = new Map();
let openccLicense = '';
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  const file = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  if (!file) break;
  const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
  if (['package/dist/esm-lib/dict/TSCharacters.js', 'package/dist/esm-lib/dict/TSPhrases.js'].includes(file)) conversionModules.set(file, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
  if (file === 'package/LICENSE') openccLicense = tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (conversionModules.size !== 2) throw new Error('OpenCC conversion modules missing');
const table = name => JSON.parse(conversionModules.get(`package/dist/esm-lib/dict/${name}.js`).trim().replace(/^export default /, '').replace(/;$/, ''));
const conversionText = `${table('TSPhrases')}|${table('TSCharacters')}`;
const conversion = new Map(conversionText.split('|').map(line => { const [from, to] = line.split(' '); return [from, to || from]; }));
const maximumPhraseLength = Math.max(...conversion.keys().map(key => [...key].length));
const simplify = value => {
  const chars = [...value.normalize('NFKC')];
  let output = '';
  for (let position = 0; position < chars.length;) {
    let matched = false;
    for (let size = Math.min(maximumPhraseLength, chars.length - position); size > 0; size--) {
      const replacement = conversion.get(chars.slice(position, position + size).join(''));
      if (replacement) { output += replacement; position += size; matched = true; break; }
    }
    if (!matched) output += chars[position++];
  }
  return output;
};
const grouped = new Map();
const rejectedForms = [];
let excludedNonIdiomSenses = 0;
for (const source of raw.filter(Boolean)) {
  for (const entry of source.entries) {
    if (entry.lang_code !== 'zh' || !entry.word) continue;
    const idiom = entry.pos_title === '成語' || (entry.tags ?? []).includes('idiomatic') || (['phrase', 'adj', 'adv', 'intj', 'unknown'].includes(entry.pos) && (entry.categories ?? []).includes('漢語成語'));
    if (!idiom) { excludedNonIdiomSenses++; continue; }
    const canonical = simplify(entry.word);
    const declared = (entry.forms ?? []).filter(f => (f.tags ?? []).includes('Simplified-Chinese'));
    for (const form of declared) if (simplify(form.form) !== canonical) rejectedForms.push({ word: entry.word, declaredForm: form.form, reason: '与原词逐字简繁转换不符，不用于去重或替换词头。' });
    const previous = grouped.get(canonical);
    if (!previous) grouped.set(canonical, { ...source, entries: [{ ...entry, _canonical: canonical }], originalEntries: [entry] });
    else {
      const merged = previous.entries[0];
      for (const field of ['senses', 'forms', 'sounds', 'etymology_texts', 'etymology_examples', 'synonyms', 'antonyms', 'related']) merged[field] = [...(merged[field] ?? []), ...(entry[field] ?? [])];
      previous.originalEntries.push(entry);
    }
  }
}

const questions = [];
const coverage = { sourceWords: wordUrls.length, fetchedWords: raw.filter(Boolean).length, questions: 0, pinyin: 0, meaning: 0, etymologyNarrative: 0, etymologySourceOnly: 0, quotations: 0, examples: 0, relatedWords: 0, missingEtymologyNarrative: 0, missingPinyin: 0, skippedNoMeaning: 0, excludedNonIdiomSenses, rejectedSourceForms: rejectedForms.length };
const seen = new Set();
for (const source of grouped.values()) {
  for (const entry of source.entries) {
    if (entry.lang_code !== 'zh' || !entry.word) continue;
    const senses = (entry.senses ?? []).filter(s => !(s.tags ?? []).some(t => ['form-of', 'alt-of', 'no-gloss'].includes(t)));
    const glosses = [...new Set(senses.flatMap(s => s.glosses ?? []).filter(g => g && !/^(參見|参见|見|见|同)[「『“" ]/.test(g)))];
    if (!glosses.length) { coverage.skippedNoMeaning++; continue; }
    const simplified = (entry.forms ?? []).find(f => (f.tags ?? []).includes('Simplified-Chinese') && !/\s/.test(f.form))?.form;
    const word = entry._canonical || (simplified || entry.word).normalize('NFKC');
    if (seen.has(word)) continue;
    seen.add(word);
    const pinyin = [...new Set((entry.sounds ?? []).filter(s => (s.tags ?? []).includes('Mandarin') && (s.tags ?? []).includes('Pinyin') && !(s.tags ?? []).includes('phonetic')).map(s => s.zh_pron || s.roman).filter(Boolean))];
    const etymologyTexts = [...(entry.etymology_texts ?? []), ...(entry.etymology_text ? [entry.etymology_text] : [])];
    const etymologyExamples = entry.etymology_examples ?? [];
    const simplifiedEtymologyExamples = etymologyExamples.filter(e => (e.tags ?? []).includes('Simplified-Chinese'));
    const preferredEtymologyExamples = (simplifiedEtymologyExamples.length ? simplifiedEtymologyExamples : etymologyExamples).slice(0, 3);
    const etymology = [etymologyTexts.join('\n\n'), ...preferredEtymologyExamples.map(e => `${e.ref ? `**${e.ref}**\n\n` : ''}> ${e.text}${e.translation ? `\n\n**来源所附释读：** ${e.translation}` : ''}`)].filter(Boolean).join('\n\n');
    const hasNarrative = etymologyTexts.some(t => t.length > 60) || preferredEtymologyExamples.some(e => (e.translation?.length ?? 0) > 40 || (e.text?.length ?? 0) > 80);
    const examples = senses.flatMap(s => s.examples ?? []).filter(e => e.text);
    const simplifiedExamples = examples.filter(e => (e.tags ?? []).includes('Simplified-Chinese'));
    const preferredExamples = (simplifiedExamples.length ? simplifiedExamples : examples).slice(0, 4);
    const quotations = examples.filter(e => e.ref || e.reference || e.author || e.title).slice(0, 4);
    const related = [...new Set([...(entry.synonyms ?? []), ...(entry.antonyms ?? []), ...senses.flatMap(s => [...(s.synonyms ?? []), ...(s.antonyms ?? [])])].map(x => x.word).filter(Boolean))];
    const sourcePage = `https://zh.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`;
    const id = `ZH-I-${String(questions.length + 1).padStart(6, '0')}`;
    const variants = [...new Set([entry.word, ...(entry.forms ?? []).filter(f => (f.tags ?? []).some(t => /Chinese/.test(t))).map(f => f.form)].filter(w => w && w !== word && simplify(w) === word))];
    const meaning = source.originalEntries.length > 1 ? source.originalEntries.map(original => {
      const pronunciation = [...new Set((original.sounds ?? []).filter(s => (s.tags ?? []).includes('Mandarin') && (s.tags ?? []).includes('Pinyin') && !(s.tags ?? []).includes('phonetic')).map(s => s.zh_pron || s.roman).filter(Boolean))];
      const meanings = (original.senses ?? []).filter(s => !(s.tags ?? []).some(t => ['form-of', 'alt-of', 'no-gloss'].includes(t))).flatMap(s => s.glosses ?? []);
      return meanings.length ? `${pronunciation.length ? `**${pronunciation.join('；')}：** ` : ''}${meanings.join('；')}` : '';
    }).filter(Boolean).join('\n\n') : glosses.map((g, i) => `${i + 1}. ${g}`).join('\n');
    const explanation = [
      `### 拼音\n${pinyin.length ? pinyin.join('；') : '【缺失】该条来源没有可提取的普通话拼音，待人工核对。'}`,
      variants.length ? `### 字形\n${variants.slice(0, 6).join('、')}。保留来源字形；释义与引证保持原文，不自动简繁转换。` : '',
      `### 寓意与释义\n${meaning}`,
      `### 典故与词源\n${etymology || '【缺失】来源未提供可提取的词源资料，待人工补全；下列用例或书证不等同于成语起源。'}${etymology && !hasNarrative ? '\n\n【待补全】以上只有词源线索或简短书证，未提供完整典故叙述。' : ''}`,
      quotations.length ? `### 书证与出处线索\n${quotations.map(e => `- ${e.ref || e.reference || [e.author, e.title].filter(Boolean).join('，')}：${e.text}`).join('\n')}\n\n书证仅证明某文献使用过该词，不据此认定最早出处。` : '### 书证与出处线索\n【缺失】来源未提供结构化书证，待考证。',
      preferredExamples.length ? `### 来源用例\n${preferredExamples.map(e => `- ${e.text}${e.roman ? `（${e.roman}）` : ''}`).join('\n')}` : '### 用例\n【缺失】来源无可提取用例，待补充。',
      related.length ? `### 关联词\n${related.slice(0, 12).join('、')}。同义、反义关系以原词条对应栏目为准，勿直接互换。` : '',
      '### 使用提示\n结合上下文判断褒贬、对象与语体；本条未单独编写易错辨析，使用于正式写作前请核对来源。',
      `### 来源与授权\n改编自[中文维基词典「${entry.word}」](${sourcePage})及其[修订历史](${sourcePage}?action=history)，作者为该页贡献者，经 [Kaikki / Wiktextract](${source.url.replace(/\.jsonl$/, '.html')})提取。内容按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)分享。改动：转为练习问答、选取释义用例、增加缺失标记，原文可能含繁体。`
    ].filter(Boolean).join('\n\n');
    questions.push({ id, title: `成语：${word}`, type: 'short_answer', stemMarkdown: `请解释成语「${word}」的含义、使用语境，并尝试说出其典故或文献出处。若出处不确定，应明确说明。`, answerMarkdown: `${pinyin.length ? `**拼音：** ${pinyin.join('；')}\n\n` : ''}${meaning}`, explanationMarkdown: explanation, options: [], correctAnswers: [], difficulty: 2, depth: hasNarrative ? 3 : 2, frequency: 0, frequencyScope: '语文成语学习；未提供考试频次', frequencyBasis: '无统计依据，不推断高考或日常出现频率。', collection: 'general', status: 'pending', categoryIds: ['zh-idioms'], tagIds: ['zh-idiom', ...(hasNarrative ? ['zh-etymology-present'] : ['zh-etymology-missing'])], sourceRefs: [{ label: '中文维基词典与贡献者', url: sourcePage }, { label: 'Kaikki 结构化原条目', url: source.url }, { label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }], sourceDocument: null, sourceAnchor: null, createdAt: generatedAt, updatedAt: generatedAt });
    const originalPages = [...new Set(source.originalEntries.map(original => original.word))].map(original => ({ label: `中文维基词典「${original}」及贡献者`, url: `https://zh.wiktionary.org/wiki/${encodeURIComponent(original)}` }));
    questions.at(-1).sourceRefs = [...originalPages, { label: 'Kaikki 结构化原条目', url: source.url }, { label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }];
    coverage.pinyin += pinyin.length ? 1 : 0;
    coverage.missingPinyin += pinyin.length ? 0 : 1;
    coverage.meaning++;
    coverage.etymologyNarrative += hasNarrative ? 1 : 0;
    coverage.etymologySourceOnly += etymology && !hasNarrative ? 1 : 0;
    coverage.missingEtymologyNarrative += hasNarrative ? 0 : 1;
    coverage.quotations += quotations.length ? 1 : 0;
    coverage.examples += preferredExamples.length ? 1 : 0;
    coverage.relatedWords += related.length ? 1 : 0;
  }
}
coverage.questions = questions.length;
const pack = { schemaVersion: 1, generatedAt, domains: [{ id: 'chinese', name: '语文', description: '成语释义、拼音、典故与阅读表达；来源缺失项保留明确标记。', sortOrder: 30 }], categories: [{ id: 'zh-root', domainId: 'chinese', parentId: null, name: '语文学习', description: '成语与语言表达', sortOrder: 0 }, { id: 'zh-idioms', domainId: 'chinese', parentId: 'zh-root', name: '成语', description: '中文维基词典分类成语；典故缺失需继续审核补全', sortOrder: 0 }], tags: [{ id: 'zh-idiom', name: '成语词条', domainId: 'chinese', kind: 'topic', color: '#a16207', description: '语文成语学习' }, { id: 'zh-etymology-present', name: '已有典故资料', domainId: 'chinese', kind: 'custom', color: '#15803d', description: '来源含较长词源叙述或原典/释读，长度自动判定，不表示已人工审定' }, { id: 'zh-etymology-missing', name: '典故待补全', domainId: 'chinese', kind: 'custom', color: '#b45309', description: '来源无完整词源叙述；不能将书证等同于完整典故' }], questions, questionBanks: [{ id: 'bank-zh-idioms', name: '语文·成语学习', description: 'CC BY-SA 4.0；待审核导入，覆盖率见来源清单。', questionIds: questions.map(q => q.id) }], documents: [], papers: [] };
const manifest = { id: 'chinese-idioms-wiktionary', name: '中文维基词典成语', generatedAt, license: 'CC-BY-SA-4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', attribution: '中文维基词典各条目贡献者；Kaikki / Wiktextract：Tatu Ylonen 及贡献者。每题保留原页面和修订历史回链。', licenseVerification: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/en#7._Licensing_of_Content', sourceUrl: indexUrl, sourceVersion: 'Kaikki 2026-10-20 extraction; zhwiktionary 2026-10-01 dump', changes: ['筛选成语分类与实义条目，排除同词头的品牌/地名等非成语义项', 'NFKC规范化并参考OpenCC逐字简繁转换生成词头，保留不同读音与义项对应关系', '不把来源误填的其他成语形式用于合并，释义与引文保留来源字形', '生成简答学习条目', '缺失拼音、完整典故、书证和用例均明确标记'], conversion: { source: openccUrl, sha256: hash(conversionText), integrity: `sha512-${openccIntegrity}`, version: 'opencc-js 1.4.2 / TSCharacters', license: 'MIT AND Apache-2.0', licenseUrl: 'https://github.com/nk2028/opencc-js/blob/master/LICENSE' }, coverage, rejectedForms, failures, limitations: ['非权威规范成语词典；类别与释义需用户审核。', '部分词源字段可能包含异说或后世书证，不能据此推断最早出处。', '没有拼音时不根据逐字拼音自动补写，避免多音字误读。', '未从禁止改作词典或现代商业词典抓取内容。'], inputs: raw.filter(Boolean).map(item => ({ url: item.url, sha256: item.sha256 })), output: 'data/content-packs/chinese.json', rebuild: 'node scripts/content/chinese/chinese.mjs [--offline]' };
await fs.writeFile(path.join(root, 'data/content-packs/chinese.json'), `${JSON.stringify(pack, null, 2)}\n`);
await fs.writeFile(path.join(root, 'data/content-sources/chinese.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(root, 'data/content-sources/OPENCC-NOTICE.txt'), `OpenCC conversion data used to normalize Chinese idiom headwords.\nSource: ${openccUrl}\nPackage integrity: sha512-${openccIntegrity}\nNo package runtime is bundled into the application.\n\n${openccLicense}`);
console.log(JSON.stringify(coverage, null, 2));
if (failures.length) process.exitCode = 2;
