import {createServer} from 'node:http';
import {buildApp} from '../../server/index.js';
const app=await buildApp({databasePath:':memory:',seedPath:'./test-results/no-ai-seed.json',staticRoot:'./dist/web'});
const provider=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));const input=JSON.parse(envelope.messages[1].content);let result:any;
if(input.outputSchema.items?.[0]?.reason)result={title:'AI数据库递进卷',description:'理解事务，再辨析边界',items:input.untrustedMaterial.candidates.slice(0,input.untrustedMaterial.requestedCount).map((q:any)=>({questionId:q.id,reason:'覆盖事务基本概念与边界'}))};else result={ok:true,message:'连接成功'};
res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));}catch{res.writeHead(400);res.end('{}');}});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const port=(provider.address() as any).port;
async function api(url:string,payload:unknown,method:any='POST'){const response=await app.inject({method,url,payload});if(response.statusCode>=400)throw new Error(`${url} ${response.statusCode}`);return response.json();}
await api('/api/domains',{id:'computer',name:'计算机'});await api('/api/categories',{id:'db',domainId:'computer',name:'数据库'});
for(const [id,title,type]of [['S1','说明事务原子性','short_answer'],['S2','解释事务隔离性','short_answer'],['O1','判断事务原子性','true_false']]){const q=await api('/api/questions',{id,title,type,stemMarkdown:`${title}？`,answerMarkdown:'参考答案',explanationMarkdown:'补充解析',categoryIds:['db'],tagIds:[],...(type==='true_false'?{correctAnswers:['true']}:{})});await api('/api/questions/review',{confirmed:true,ids:[id],action:'approve',expectedUpdatedAt:{[id]:q.updatedAt}});}
await api('/api/ai/settings',{enabled:true,baseUrl:`http://127.0.0.1:${port}`,model:'isolated-ui-test',key:'qa-fixture',supportsImages:false,sendImages:false,timeoutSeconds:30,maxTokens:4096},'PUT');
await app.listen({host:'127.0.0.1',port:4357});console.log('AI_UI_READY');
const close=async()=>{await app.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));process.exit();};process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
