/** Small disposable fixture for terminology and portable English references. */
import{readFile}from'node:fs/promises';import{resolve}from'node:path';import assert from'node:assert/strict';
import{buildApp}from'../../server/index.js';import{validatePack,asShare}from'../content/manage.js';
const app=await buildApp({databasePath:':memory:',seedPath:'test-results/no-terminology-fixture.json',staticRoot:resolve('dist/web')});
const packs=['terms-programming','terms-systems','terms-ai','terms-domains','terms-chemistry','terms-medicine','terms-medicine-clinical'];const fixture:any={termIds:[]};
app.get('/qa/terminology-fixture',async()=>fixture);
for(const name of packs){const source=validatePack(JSON.parse(await readFile('data/content-packs/'+name+'.json','utf8')));const selected=name==='terms-ai'?[source.questions.find(q=>q.id==='TERM-AI-supervised-learning')!]:[source.questions[0]];const data=asShare(source,name,selected);const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{...data,documents:[],generatedAt:data.exportedAt,format:undefined,title:undefined,exportedAt:undefined}}});assert.ok(response.statusCode<400,response.body);fixture.termIds.push(selected[0]!.id);if(name==='terms-ai')fixture.referenceTermId=selected[0]!.id;}
const words=validatePack(JSON.parse(await readFile('data/content-packs/english.json','utf8'))),word=words.questions.find(q=>q.title==='learn')!;assert.ok(word);
const part=asShare(words,'word',[word]);part.questions[0]={...part.questions[0],id:'remapped-english-learn'};part.questionBanks=[];
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{...part,documents:[],generatedAt:part.exportedAt,format:undefined,title:undefined,exportedAt:undefined}}});assert.ok(imported.statusCode<400,imported.body);
fixture.wordId='remapped-english-learn';
const bare=await buildApp({databasePath:':memory:',seedPath:'test-results/no-terminology-fixture.json',staticRoot:resolve('dist/web')});fixture.bareOrigin=await bare.listen({host:'127.0.0.1',port:0});
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('TERMINOLOGY_READY '+JSON.stringify({origin}));
async function close(){await app.close();await bare.close();process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
