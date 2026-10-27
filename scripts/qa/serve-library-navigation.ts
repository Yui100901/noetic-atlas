import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';
const app=await buildApp({databasePath:':memory:',seedPath:'missing-navigation-seed',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
async function api(url:string,payload?:unknown,method:any='POST'){const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();}
await api('/api/domains',{id:'GEO-QA',name:'地理学'});
await api('/api/categories',{id:'HYDRO-QA',name:'水文基础',domainId:'GEO-QA'});
await api('/api/tags',{id:'WATER-QA',name:'水循环',domainId:'GEO-QA',kind:'topic',color:'#3399bb'});
for(let i=1;i<=58;i++){
 const q=await api('/api/questions',{id:'NAV-'+String(i).padStart(3,'0'),title:`水文基础填空 ${i}`,type:'fill_blank',stemMarkdown:'相对赤道南北角位置的坐标名称是{{answer}}。\n\n代码示例保持原样：`{{answer}}`',answerMarkdown:'纬度。',explanationMarkdown:'经度描述东西角位置。',blanks:[{id:'latitude',label:'坐标名称',answers:['纬度']}],categoryIds:['HYDRO-QA'],tagIds:['WATER-QA'],difficulty:2,depth:2,frequency:3});
 await api('/api/questions/review',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});
}
console.log('LIBRARY_NAVIGATION_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));
const close=async()=>{await app.close();process.exit(0);};process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
