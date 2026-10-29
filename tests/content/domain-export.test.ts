import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { importShare } from '../../server/modules/sharing/routes.js';
import type { Domain, Question } from '../../shared/models/types.js';
import type { SharePackage } from '../../shared/models/sharing.js';
import { buildDomainParts, DOMAIN_PART_MAX_BYTES, DOMAIN_PART_MAX_QUESTIONS, exportDomainPacks, main } from '../../scripts/content/export-domains.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-10-23T00:00:00.000Z';
const domainIds = ['computer-science','english','japanese','chinese','driving','chemistry','medicine-pharmacy'];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const canary = 'NEVER-EXPORT-PRIVATE-STATE';
function addQuestion(store: Store, id: string, domain: string, fields: Partial<Question> = {}) {
  const question = { ...questionSchema.parse({ id, title: id, type: 'short_answer', stemMarkdown: '解释这个概念。', answerMarkdown: '基础原理。', categoryIds: ['category-' + domain], tagIds: ['topic-' + domain], status: 'published', ...fields }), id, createdAt: stamp, updatedAt: stamp } as Question;
  store.put('questions', id, question);
  return question;
}
function populate(store: Store) {
  for (const [index,id] of domainIds.entries()) {
    store.put('domains', id, { id, name: id, description: '', sortOrder: index });
    store.put('categories', 'category-' + id, { id: 'category-' + id, domainId: id, name: id, description: '', parentId: null, sortOrder: 0 });
    store.put('tags', 'topic-' + id, { id: 'topic-' + id, domainId: id, name: id, description: '', kind: 'topic', color: '#123456' });
  }
  store.put('categories', 'computer-root', { id: 'computer-root', domainId: 'computer-science', name: '基础', parentId: null, description: '', sortOrder: 0 });
  store.put('categories', 'category-computer-science', { ...store.require('categories','category-computer-science'), parentId: 'computer-root' });
}
async function fixture(t: TestContext, version = '1.0.0') {
  const root = await mkdtemp(join(tmpdir(),'atlas-domain-export-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root,'data/content-sources'), { recursive: true });
  await mkdir(join(root,'docs/licenses'), { recursive: true });
  await writeFile(join(root,'package.json'), JSON.stringify({ name: 'noetic-atlas', version }));
  await writeFile(join(root,'data/content-sources/source.json'), JSON.stringify({ source: 'fixture', license: 'source-specific' }));
  await writeFile(join(root,'docs/licenses/license.html'), '<p>Retain this licence.</p>');
  await writeFile(join(root,'data/private.json'), canary);
  await writeFile(join(root,'docs/private.md'), canary);
  const database = join(root,'data/noetic-atlas.sqlite');
  const store = new Store(database);
  populate(store);
  for (const id of domainIds.slice(0,6)) addQuestion(store, 'public-' + id, id);
  const drug = addQuestion(store,'public-shared-drug','medicine-pharmacy', { categoryIds: ['category-medicine-pharmacy','category-chemistry'], tagIds: ['topic-medicine-pharmacy','topic-chemistry'] });
  addQuestion(store,'private-question','computer-science',{ collection: 'personal', title: canary });
  for (const status of ['pending','draft','archived'] as const) addQuestion(store,'not-published-' + status,'computer-science',{ status, title: canary });
  const cs = store.require<Question>('questions','public-computer-science');
  store.put('questions',cs.id,{ ...cs, explanationMarkdown: '[word](#/questions/public-english)', sourceDocument: canary, sourceAnchor: canary, study: { questionId: cs.id, notes: canary, favorite: true, mastery: 1, nextReviewAt: null, lastReviewedAt: null, wrongCount: 0 } });
  const image = { id: 'diagram', filename: 'sign.png', mimeType: 'image/png', dataBase64: png, sizeBytes: Buffer.from(png,'base64').length, width: 1, height: 1, createdAt: stamp };
  store.put('assets',image.id,image);
  const driving = store.require<Question>('questions','public-driving');
  store.put('questions',driving.id,{ ...driving, stemMarkdown: '![标志](/api/assets/diagram/content)' });
  store.put('study',cs.id,{ questionId: cs.id, notes: canary });
  store.put('settings','system',{ token: canary });
  store.database.putRecord('ai_settings','local',{ apiKey: canary });
  store.put('documents','private-document',{ id: 'private-document', title: canary });
  store.put('papers','private-paper',{ id: 'private-paper', title: canary });
  store.put('attempts','private-attempt',{ id: 'private-attempt', notes: canary });
  store.put('paper_drafts','private-draft',{ id: 'private-draft', title: canary });
  store.put('question_banks','private-bank',{ id: 'private-bank', name: canary, questionIds: [cs.id] });
  store.database.close();
  return { root, database, drug };
}
function unzip(bytes: Buffer) {
  const files = new Map<string, Buffer>();
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const size = bytes.readUInt32LE(cursor+18), nameSize = bytes.readUInt16LE(cursor+26);
    const start = cursor+30+nameSize+bytes.readUInt16LE(cursor+28);
    const name = bytes.subarray(cursor+30,cursor+30+nameSize).toString('utf8').split('/').slice(1).join('/');
    files.set(name,inflateRawSync(bytes.subarray(start,start+size)));
    cursor = start+size;
  }
  return files;
}

for (const version of ['1.0.0', '1.5']) {
test(`domain CLI preserves ${version} and exports importable pending banks without modifying source`, async t => {
  const { root, database } = await fixture(t, version);
  const before = sha(await readFile(database));
  const result = await exportDomainPacks({ root });
  assert.equal(result.version,version);
  assert.equal(result.output,join(root,'artifacts/domain-packs',`v${version}`));
  assert.equal(sha(await readFile(database)),before);
  assert.deepEqual(result.counts,{ domains: 7, uniqueQuestions: 7, domainQuestionMemberships: 8, crossDomainQuestions: 1, duplicateMemberships: 1 });
  assert.equal((await readdir(result.output)).length,9);
  assert.deepEqual(result.domains.map(domain => domain.domainId),domainIds);
  const allIds = new Set<string>(), byDomain = new Map<string,SharePackage>();
  for (const domain of result.domains) {
    assert.equal(domain.file,`noetic-atlas-content-${domain.domainId}-${version}.zip`);
    const bytes = await readFile(join(result.output,domain.file));
    assert.equal(sha(bytes),domain.sha256);
    const firstName=bytes.subarray(30,30+bytes.readUInt16LE(26)).toString('utf8');
    assert.ok(firstName.startsWith(`noetic-atlas-content-${domain.domainId}-${version}/`));
    const files = unzip(bytes);
    assert.ok(files.has('licenses/license.html')); assert.ok(files.has('sources/source.json'));
    assert.ok(![...files.values()].some(data => data.includes(canary)));
    const manifest = JSON.parse(files.get('domain-manifest.json')!.toString('utf8'));
    assert.equal(manifest.version,version);
    assert.equal(manifest.redistributionReviewRequired,domain.domainId==='driving');
    assert.equal(manifest.rights.redistributionReviewRequired,domain.domainId==='driving');
    assert.equal(manifest.rights.blanketSublicense,false);
    for (const [name,file] of Object.entries(manifest.files) as Array<[string,{bytes:number;sha256:string}]>) {
      assert.equal(files.get(name)!.length,file.bytes);
      assert.equal(sha(files.get(name)!),file.sha256);
    }
    for (const line of files.get('SHA256SUMS.txt')!.toString('utf8').trim().split('\n')) {
      const [digest,name] = line.split('  ');
      assert.equal(sha(files.get(name!)!),digest);
    }
    const share = JSON.parse(files.get('part-001.json')!.toString('utf8')) as SharePackage;
    byDomain.set(domain.domainId,share);
    for (const question of share.questions) { allIds.add(question.id); assert.equal(question.status,'pending'); assert.equal(question.collection,'general'); }
    assert.deepEqual(share.papers,[]); assert.deepEqual(share.questionBanks,[]);
    const recipient = new Store(':memory:');
    try { importShare(recipient,share); assert.equal(recipient.all('questions').length,domain.questions); }
    finally { recipient.database.close(); }
  }
  assert.equal(allIds.size,7);
  assert.deepEqual(new Set(byDomain.get('computer-science')!.categories.map(c => c.id)),new Set(['computer-root','category-computer-science']));
  assert.doesNotMatch(byDomain.get('computer-science')!.questions[0]!.explanationMarkdown,/#\/questions\/public-english/);
  assert.equal(byDomain.get('computer-science')!.questions[0]!.sourceDocument,null);
  assert.equal(byDomain.get('driving')!.assets[0]!.dataBase64,png);
  const cs = byDomain.get('computer-science')!.questions[0]!;
  assert.equal(cs.sourceRefs.length,0); // Old seed questions may have no individual references.
  assert.equal(byDomain.get('english')!.questions[0]!.explanationMarkdown,''); // No invented explanation.
  const recipient = new Store(':memory:');
  try {
    importShare(recipient,byDomain.get('chemistry')!);
    const repeated = importShare(recipient,byDomain.get('medicine-pharmacy')!);
    assert.equal(repeated.counts.questions!.reused,1);
    assert.equal(recipient.all('questions').length,2);
    assert.equal(recipient.require<Question>('questions','public-shared-drug').status,'pending');
  } finally { recipient.database.close(); }
  const sums = await readFile(join(result.output,'CONTENT-SHA256SUMS.txt'),'utf8');
  assert.ok(sums.includes(`${sha(await readFile(join(result.output,'domain-manifest.json')))}  domain-manifest.json`));
});
}

test('explicit domain selection retains complete cross-domain taxonomy without leaking other questions', async t => {
  const { root } = await fixture(t);
  const result = await exportDomainPacks({ root, domains: ['medicine-pharmacy'] });
  assert.equal(result.domains.length,1);
  assert.equal(result.counts.uniqueQuestions,1);
  const entries = unzip(await readFile(join(result.output,result.domains[0]!.file)));
  const share = JSON.parse(entries.get('part-001.json')!.toString('utf8')) as SharePackage;
  assert.deepEqual(share.questions.map(question => question.id),['public-shared-drug']);
  assert.deepEqual(new Set(share.domains.map(domain => domain.id)),new Set(['medicine-pharmacy','chemistry']));
  assert.equal(share.categories.length,2);
  assert.equal(share.tags.length,2);
});

test('domain export refuses existing output and unknown or empty domains before publishing files', async t => {
  const { root, database } = await fixture(t);
  const output = join(root,'artifacts/existing');
  await mkdir(output,{ recursive: true });
  await writeFile(join(output,'keep.txt'),'Keep me');
  await assert.rejects(exportDomainPacks({ root, output }),/已存在/);
  assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'Keep me');
  await assert.rejects(exportDomainPacks({ root, domains: ['unknown'] }),/不存在的领域/);
  await assert.rejects(exportDomainPacks({ root, domains: [''] }),/空领域/);
  const source = new Store(database);
  try { source.put('domains','empty',{ id: 'empty', name: 'empty', description: '', sortOrder: 9 }); }
  finally { source.database.close(); }
  await assert.rejects(exportDomainPacks({ root, domains: ['empty'] }),/没有已发布/);
  await assert.rejects(exportDomainPacks({ root, database: 'missing.sqlite' }),/不存在/);
  assert.deepEqual(await readdir(join(root,'artifacts')),['existing']);
});

test('parts cap at 500 questions and independently rewrite out-of-part links', () => {
  const store = new Store(':memory:');
  try {
    populate(store);
    const ids = Array.from({length:502},(_,index) => 'item-' + String(index).padStart(4,'0'));
    for (const id of ids) addQuestion(store,id,'computer-science');
    store.put('questions',ids[0]!,{ ...store.require('questions',ids[0]!), explanationMarkdown: `[other](#/questions/${ids[501]})` });
    store.put('questions',ids[500]!,{ ...store.require('questions',ids[500]!), explanationMarkdown: `[same part](#/questions/${ids[501]})` });
    const parts = buildDomainParts(store,store.require<Domain>('domains','computer-science'),ids,stamp);
    assert.equal(DOMAIN_PART_MAX_QUESTIONS,500); assert.equal(DOMAIN_PART_MAX_BYTES,80*1024*1024);
    assert.deepEqual(parts.map(part => part.share.questions.length),[500,2]);
    assert.doesNotMatch(parts[0]!.share.questions[0]!.explanationMarkdown,/#\/questions\/item-0501/);
    assert.match(parts[1]!.share.questions[0]!.explanationMarkdown,/#\/questions\/item-0501/);
    for (const part of parts) {
      const recipient = new Store(':memory:');
      try { importShare(recipient,JSON.parse(part.data.toString('utf8'))); assert.ok(recipient.all<Question>('questions').every(question => question.status==='pending')); }
      finally { recipient.database.close(); }
    }
  } finally { store.database.close(); }
});

test('byte limit applies to final UTF-8 payload with self-contained assets and rejects a single oversize question', () => {
  const store = new Store(':memory:');
  try {
    populate(store);
    const ids = ['one','two','three'];
    for (const id of ids) addQuestion(store,id,'computer-science',{ explanationMarkdown: '中文'.repeat(400) });
    store.put('assets','byte-diagram',{ id: 'byte-diagram', filename: 'pic.png', mimeType: 'image/png', dataBase64: png, sizeBytes: Buffer.from(png,'base64').length, width: 1, height: 1, createdAt: stamp });
    store.put('questions','one',{ ...store.require('questions','one'), stemMarkdown: '![图](/api/assets/byte-diagram/content)' });
    const domain = store.require<Domain>('domains','computer-science');
    const full = buildDomainParts(store,domain,ids,stamp)[0]!;
    const single = buildDomainParts(store,domain,[ids[0]!],stamp)[0]!;
    const limit = single.data.length+200;
    assert.ok(full.data.length>limit);
    const parts = buildDomainParts(store,domain,ids,stamp,limit);
    assert.equal(parts.length,3);
    assert.ok(parts.every(part => part.data.length<limit));
    assert.equal(parts[0]!.share.assets[0]!.dataBase64,png);
    assert.equal(parts[1]!.share.assets.length,0);
    assert.throws(() => buildDomainParts(store,domain,[ids[0]!],stamp,single.data.length),/单题/);
    assert.throws(() => buildDomainParts(store,domain,ids,stamp,DOMAIN_PART_MAX_BYTES+1),/限制无效/);
  } finally { store.database.close(); }
});

test('metadata symlinks cannot include private files outside the source and licence directories', async t => {
  const { root } = await fixture(t);
  await symlink(join(root,'data/private.json'),join(root,'data/content-sources/link.json'),'file');
  await assert.rejects(exportDomainPacks({ root }),/超出允许目录|符号链接/);
  assert.ok(!(await readdir(root)).includes('artifacts'));
});

test('CLI rejects unknown and missing values without touching the default workspace database', async () => {
  await assert.rejects(main(['--unknown']),/未知参数/);
  await assert.rejects(main(['--output']),/需要参数/);
  await assert.rejects(main(['--database','--output','x']),/需要参数/);
});
