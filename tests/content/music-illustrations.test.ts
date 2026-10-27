import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {buildPaper,createAttempt} from '../../server/modules/practice/service.js';
import {applyMusicIllustrations} from '../../scripts/content/music-notation/apply.js';
// @ts-expect-error Authoring module intentionally uses JavaScript.
import {illustrateMusicQuestion} from '../../scripts/content/music-notation/enrich.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZkAAAAASUVORK5CYII=';
const asset={id:'music-notation-quarter-test',filename:'quarter.png',mimeType:'image/png',dataBase64:png,sizeBytes:Buffer.from(png,'base64').length,width:1,height:1,createdAt:'2026-10-27T00:00:00.000Z'};
const illustrations={entries:[{key:'quarter',alt:'四分音符符号示意',assetId:asset.id},{key:'values',alt:'时值对照',assetId:asset.id}],assets:[asset]};
const make=(id:string)=>({...questionSchema.parse({id,title:'四分音符',type:'short_answer',stemMarkdown:'四分音符',answerMarkdown:'常用相对时值单位。',explanationMarkdown:'实际时间需结合速度。',status:'published',concept:{term:'四分音符',meaningPrompt:'在常用比例中等于两个八分单位的时值符号',acceptedAnswers:['四分音符']}}),id});
test('named symbols appear beside concepts, objective hints stay after submission, and repeated enrichment is idempotent',()=>{
 const q=make('q'),next=illustrateMusicQuestion(q,illustrations);assert.ok(next.stemMarkdown.includes('/api/assets/'+asset.id));assert.equal(next.concept.meaningPrompt,q.concept.meaningPrompt);assert.equal(next.answerMarkdown,q.answerMarkdown);assert.deepEqual(illustrateMusicQuestion(next,illustrations),next);
 const objective={...q,type:'true_false',concept:undefined,stemMarkdown:'全音符一定占满一小节。',correctAnswers:['false']};const out=illustrateMusicQuestion(objective,illustrations);assert.equal(out.stemMarkdown,objective.stemMarkdown);assert.ok(out.explanationMarkdown.includes('/api/assets/'));
});
test('illustration migration preserves study, answers and historic attempts while versioning unchanged active set snapshots',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());const q=make('q');store.put('questions',q.id,q);store.putStudy({...store.study(q.id),favorite:true,notes:'私有笔记保留'});
 const paper=buildPaper(store,{id:'set',title:'乐理',mode:'manual',questionIds:[q.id],scoring:{enabled:false}});store.put('papers',paper.id,paper);
 const attempt=createAttempt(store,paper);store.put('attempts',attempt.id,attempt);const frozenAttempt=store.require('attempts',attempt.id);
 const oldStudy=store.all('study'),oldAnswers=q.answerMarkdown;
 const result=applyMusicIllustrations(store,illustrations,new Set([q.id]));assert.equal(result.questions,1);assert.equal(result.addedAssets,1);assert.equal(result.paperVersions.length,1);
 assert.deepEqual(store.all('study'),oldStudy);assert.deepEqual(store.require('attempts',attempt.id),frozenAttempt);assert.equal(store.require('questions','q').answerMarkdown,oldAnswers);assert.equal(store.require('papers','set').version,paper.version+1);assert.ok(store.require<any>('papers','set').snapshot[0].stemMarkdown.includes('/api/assets/'));
 assert.equal(applyMusicIllustrations(store,illustrations,new Set([q.id])).questions,0);
});
test('music font provenance pins hashes and keeps its open font notice',()=>{
 const source=JSON.parse(readFileSync('scripts/content/music-notation/font-source.json','utf8'));assert.match(source.revision,/^[a-f0-9]{40}$/);assert.ok(source.files.every((f:any)=>/^[a-f0-9]{64}$/.test(f.sha256)));assert.match(readFileSync('scripts/content/music-notation/LICENSE-Bravura.txt','utf8'),/SIL OPEN FONT LICENSE/);
});
test('new illustration versions replace owned images once and preserve code examples',()=>{
 const q=make('q'),old='/api/assets/music-notation-quarter-000000000000/content';
 const updated=illustrateMusicQuestion({...q,stemMarkdown:q.stemMarkdown+`\n\n![旧版本](${old})\n\n\`![代码示例](${old})\``},illustrations);
 assert.equal((updated.stemMarkdown.match(new RegExp(asset.id,'g'))||[]).length,1);assert.equal((updated.stemMarkdown.match(/000000000000/g)||[]).length,1);
 assert.ok(updated.stemMarkdown.includes('`![代码示例]('+old+')`'));
 const codeOnly=illustrateMusicQuestion({...q,stemMarkdown:q.stemMarkdown+`\n\n\`![示例](/api/assets/${asset.id}/content)\``},illustrations);
 assert.equal((codeOnly.stemMarkdown.match(new RegExp(asset.id,'g'))||[]).length,2,'literal image syntax must not suppress the actual illustration');
});
