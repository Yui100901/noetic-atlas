import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('mobile shares self-contained content through production WASM routes and retains library subject metadata',async t=>{


  const {createLocalRuntime}=await loadNativeRuntime();
  const sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  const seed={schemaVersion:1,domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};let durable:Uint8Array|undefined,failSave=false,saves=0;
  const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw new Error('simulated full disk');durable=bytes.slice();saves++;}};
  let runtime=await createLocalRuntime(sql,seed,storage);t.after(()=>runtime.close());
  const api=async(path:string,method='GET',data?:unknown,status=200):Promise<any>=>{const response=await runtime.fetch(path,{method,...(data===undefined?{}:{body:JSON.stringify(data)})});const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
  await api('/api/domains','POST',{id:'mobile-share-domain',name:'移动分享源领域'},201);await api('/api/categories','POST',{id:'mobile-share-category',name:'分享细分类',domainId:'mobile-share-domain'},201);await api('/api/tags','POST',{id:'mobile-share-tag',name:'分享标签',domainId:'mobile-share-domain',kind:'topic'},201);
  const image=await api('/api/assets','POST',{filename:'移动分享.png',mimeType:'image/png',dataBase64:png},201);
  const question=await api('/api/questions','POST',{id:'mobile-share-question',title:'移动端分享题',type:'short_answer',stemMarkdown:`![移动图片](/api/assets/${image.id}/content)`,answerMarkdown:'解释图片',categoryIds:['mobile-share-category'],tagIds:['mobile-share-tag']},201);
  await api('/api/questions/review','POST',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
  const paper=await api('/api/papers','POST',{title:'移动端分享卷',mode:'manual',questionIds:[question.id],scoring:{enabled:true,totalPoints:5,questionPoints:{[question.id]:5}}},201);
  const data=await api('/api/sharing/export','POST',{kind:'paper',id:paper.id});assert.equal(data.assets[0].dataBase64,png);assert.equal(data.questions[0].study,undefined);assert.ok(!('ai'in data));
  await runtime.close();durable=undefined;runtime=await createLocalRuntime(sql,seed,storage);
  await api('/api/domains','POST',{id:'mobile-share-domain',name:'接收方已有不同领域'},201);
  const preview=await api('/api/sharing/preview','POST',{data});assert.equal(preview.counts.domains.remapped,1);assert.equal((await api('/api/questions?status=all')).total,0);
  await t.test('mobile share import remaps dependencies, keeps all image bytes and pending review through reopen',async()=>{
    await api('/api/sharing/import','POST',{data,confirmed:true,expectedFingerprint:preview.fingerprint});const incoming=(await api('/api/questions?status=pending')).items[0];assert.ok(incoming);assert.equal((await api(`/api/assets/${image.id}/data`)).dataBase64,png);assert.equal((await api(`/api/papers/${paper.id}`)).archived,true);assert.equal((await api(`/api/papers/${paper.id}`)).scoring.totalPoints,5);
    const taxonomy=await api('/api/taxonomy');assert.equal(taxonomy.domains.length,2);const importedDomain=taxonomy.domains.find((entry:any)=>entry.name==='移动分享源领域');assert.notEqual(importedDomain.id,'mobile-share-domain');assert.equal(taxonomy.categories[0].domainId,importedDomain.id);
    await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);assert.equal((await api(`/api/questions/${incoming.id}`)).status,'pending');assert.equal((await api('/api/sharing/preview','POST',{data})).counts.questions.reused,1);
  });
  await t.test('mobile library metadata is queryable and failed share durable writes restore the complete graph',async()=>{
    const taxonomy=await api('/api/taxonomy');const importedDomain=taxonomy.domains.find((entry:any)=>entry.name==='移动分享源领域');const document=await api('/api/documents','POST',{title:'手机书籍',kind:'书籍',bodyMarkdown:'# 书籍',domainIds:[importedDomain.id],categoryIds:['mobile-share-category'],author:'移动作者',publisher:'出版社',publishedYear:'2025'},201);assert.equal((await api(`/api/documents?domainId=${importedDomain.id}&kind=书籍&search=移动作者`))[0].id,document.id);
    const page=await api(`/api/documents/page?domainId=${importedDomain.id}&kind=书籍&search=移动作者&page=99&pageSize=10`);assert.equal(page.total,1);assert.equal(page.page,1);assert.equal(page.items[0].id,document.id);assert.equal(page.items[0].bodyMarkdown,undefined);assert.equal(page.items[0].excerpt,' 书籍');assert.equal((await api('/api/documents/page?search='+encodeURIComponent("%_' OR 1=1 --"))).total,0);
    const changed=structuredClone(data);changed.questions[0].id='mobile-failed-share-question';changed.questions[0].title='写入失败不得留下';changed.papers=[];const before=durable!.slice();failSave=true;await api('/api/sharing/import','POST',{data:changed,confirmed:true},507);failSave=false;assert.deepEqual(durable,before);await api('/api/questions/mobile-failed-share-question','GET',undefined,404);assert.equal((await api(`/api/documents/${document.id}`)).author,'移动作者');
    const expected=await api('/api/documents/page');await runtime.close();
    const legacy=new sql.Database(durable!);legacy.run('DROP TABLE document_read_model');durable=legacy.export();legacy.close();
    runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.deepEqual(await api('/api/documents/page'),expected);
    const beforeReads=saves;await api('/api/documents/page?search='+encodeURIComponent('移动作者'));await api('/api/documents/kinds');assert.equal(saves,beforeReads,'warm card reads do not persist the database');
    failSave=true;await api('/api/documents/'+document.id,'PUT',{...document,bodyMarkdown:'UNSAVED_LIBRARY_SEARCH_GHOST'},507);failSave=false;
    assert.equal((await api('/api/documents/page?search=UNSAVED_LIBRARY_SEARCH_GHOST')).total,0);assert.deepEqual(await api('/api/documents/page'),expected);

  });
});
