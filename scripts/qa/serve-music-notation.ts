/** Offline, synthetic notation examples; no content pack or font cache needed. */
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';
import {questionSchema} from '../../server/core/validation.js';
// @ts-expect-error Plain JavaScript authoring helper has no declaration file.
import {illustrateMusicQuestion} from '../content/music-notation/enrich.mjs';

// Original vector samples keep this fixture independent of the optional
// Bravura download. Rasterize once during setup; the app receives only PNGs.
const frame=(body:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="190" viewBox="0 0 480 190"><rect width="480" height="190" rx="12" fill="white"/><g fill="#17252b" stroke="#17252b">${body}</g></svg>`;
const staff=(x:number,y:number,width:number,gap=16)=>Array.from({length:5},(_,index)=>`<path d="M${x} ${y+index*gap}h${width}" fill="none" stroke-width="1.5"/>`).join('');
const treble=(transform:string)=>`<g transform="${transform}"><path d="M31 138 C45 149 16 159 18 140 C23 121 39 116 34 99 C30 80 18 61 25 43 C32 25 40 15 35 7 C28 -2 17 19 19 34 C22 54 42 72 44 91 C48 117 11 126 4 102 C-2 79 18 62 32 67 C47 71 45 92 31 96 C18 100 15 82 26 81" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
const label=(x:number,value:string)=>`<text x="${x}" y="167" text-anchor="middle" font-family="sans-serif" font-size="13" stroke="none">${value}</text>`;
const diagrams=[
  {key:'g-symbol',alt:'G谱号符号示意',svg:frame(treble('translate(210 15)'))},
  {key:'treble',alt:'高音谱号第二线的G4位置',svg:frame(staff(35,54,410)+treble('translate(70 49) scale(.65)')+'<path d="M155 102h270" stroke="#bd4153" stroke-width="2"/>'+label(290,'G4 - second line from bottom'))},
  {key:'quarter',alt:'四分音符符号示意',svg:frame('<ellipse cx="226" cy="125" rx="16" ry="10" transform="rotate(-20 226 125)"/><path d="M240 122V42" stroke-width="5"/>')},
  {key:'rests',alt:'全、二分、四分、八分和十六分休止符对照',svg:frame(
    [0,1,2,3,4].map(index=>staff(18+index*94,52,68,12)).join('')+
    '<path d="M39 64h26v8H39zM133 68h26v8h-26z" stroke="none"/>'+
    '<path d="M237 51l14 18-13 18 13 15-12-4q-12 2-4 16l-14-14q-4-11 11-13l-10-15 13-12z" stroke="none"/>'+
    '<path d="M337 66q-10 22-17 46M337 66q-12 17-22 8" fill="none" stroke-width="4"/><circle cx="314" cy="70" r="6"/>'+
    '<path d="M435 57q-8 28-19 55M435 57q-12 17-22 8M429 80q-12 17-22 8" fill="none" stroke-width="4"/><circle cx="412" cy="62" r="6"/><circle cx="406" cy="85" r="6"/>'+
    ['whole','half','quarter','eighth','sixteenth'].map((value,index)=>label(52+index*94,value)).join(''))},
];
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const channel=process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':'chromium');
const browser=await chromium.launch({headless:true,...(channel==='chromium'?{}:{channel})});
const assets=[],entries=[];
try{
  const page=await browser.newPage({viewport:{width:480,height:190},deviceScaleFactor:1,serviceWorkers:'block'});
  await page.route('**/*',route=>route.abort());
  for(const diagram of diagrams){
    await page.setContent(`<html><body style="margin:0">${diagram.svg}</body></html>`);
    const bytes=await page.locator('svg').screenshot({type:'png'}),sha256=createHash('sha256').update(bytes).digest('hex');
    const asset={id:`music-notation-${diagram.key}-${sha256.slice(0,12)}`,filename:`${diagram.key}.png`,mimeType:'image/png',sizeBytes:bytes.length,dataBase64:bytes.toString('base64'),width:480,height:190,createdAt:'2026-11-04T00:00:00.000Z'};
    assets.push(asset);entries.push({key:diagram.key,alt:diagram.alt,assetId:asset.id,sha256});
  }
}finally{await browser.close();}
const illustrations={assets,entries};
const concepts=[
  {term:'高音谱号',meaningPrompt:'以第二线为G4位置的常用G记号形式',explanationMarkdown:'从下向上数的第二线为G4，需要结合谱表的位置读音。'},
  {term:'四分音符',meaningPrompt:'在常用比例中等于两个八分单位的时值符号',explanationMarkdown:'是否用作一拍取决于拍号与实际节拍层级。'},
  {term:'休止符',meaningPrompt:'标示所属声部在指定时值内不发出音响的记号',explanationMarkdown:'没有音响仍占用对应的音乐时间。'},
];
const questions=[
  ...concepts.map((concept,index)=>questionSchema.parse({id:`MUSIC-QA-CONCEPT-${index+1}`,title:concept.term,type:'short_answer',stemMarkdown:`请说明${concept.term}的含义。`,answerMarkdown:concept.meaningPrompt,explanationMarkdown:concept.explanationMarkdown,categoryIds:['music-qa-notation'],status:'published',concept:{term:concept.term,meaningPrompt:concept.meaningPrompt,acceptedAnswers:[concept.term]}})),
  questionSchema.parse({id:'MUSIC-QA-OBJECTIVE',title:'休止与时值判断',type:'true_false',stemMarkdown:'休止符不占用音乐时间。',correctAnswers:['false'],answerMarkdown:'错误。',explanationMarkdown:'静默仍有时值，需要计入节拍。',categoryIds:['music-qa-notation'],status:'published'}),
].map(question=>illustrateMusicQuestion(question,illustrations));
const app=await buildApp({databasePath:':memory:',seedPath:'missing-music-qa-seed',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{schemaVersion:1,domains:[{id:'music-qa',name:'音乐符号隔离样本',description:'合成记谱展示与附件验收。',sortOrder:0}],categories:[{id:'music-qa-notation',domainId:'music-qa',parentId:null,name:'记谱',description:'合成符号样本。',sortOrder:0}],tags:[],questions,documents:[],papers:[],assets}}});
assert.equal(response.statusCode,200,response.body);
const byTerm=Object.fromEntries(questions.filter(question=>question.concept).map(question=>[question.concept.term,question.id]));
const objective=questions.find(question=>question.type==='true_false'&&question.explanationMarkdown.includes('/api/assets/'));
assert.ok(objective,'Objective fixture includes an explanation-only illustration');
const p=await app.inject({method:'POST',url:'/api/papers',payload:{title:'离线音乐符号测试',mode:'manual',practiceKind:'concept',questionIds:[byTerm['高音谱号'],byTerm['四分音符'],byTerm['休止符']],scoring:{enabled:false}}});
assert.equal(p.statusCode,201,p.body);
console.log('MUSIC_NOTATION_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0}),byTerm,objectiveId:objective.id,paperId:p.json().id}));
const close=async()=>{await app.close();process.exit(0);};process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
