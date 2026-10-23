/** Frontend-only stream fixture: no real database, key or model is accessed. */
import {createServer, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {DEFAULT_SETTINGS} from '../../shared/models/settings.js';
import {DEFAULT_AI_SETTINGS} from '../../shared/ai/ai.js';

const staticRoot=resolve('dist/web');
const requests:Array<{url:string;body:any;accept:string}>=[];
const waiting=new Map<number,{response:ServerResponse;mode:string;run:unknown}>();let sequence=0,closed=0;
const json=(response:ServerResponse,value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
const event=(response:ServerResponse,value:unknown)=>response.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
function run(id:number){return{id:`stream-${id}`,kind:'paper_plan',status:'completed',createdAt:new Date().toISOString(),model:'isolated-ui-stream',warnings:[],questionIds:['S1','S2'],result:{title:`实时事务练习 ${id}`,description:'理解基本概念，再练习应用。',requestedCount:2,candidateCount:2,candidates:[{id:'S1',title:'事务原子性',type:'short_answer'},{id:'S2',title:'事务隔离性',type:'short_answer'}],items:[{questionId:'S1',reason:'基础理解'},{questionId:'S2',reason:'应用边界'}],retrieval:{availableCount:1000,matchedCount:400,reviewedCount:360,batches:3,interpreted:true,summary:'计算机 / 数据库 / 基础与应用'}}};}
const server=createServer(async(request,response)=>{
  try{
    const url=new URL(request.url||'/','http://127.0.0.1');
    if(url.pathname==='/qa/state')return json(response,{requests,pending:[...waiting.keys()],closed});
    if(url.pathname==='/qa/release'){
      for(const[id,entry]of waiting){waiting.delete(id);if(entry.response.destroyed)continue;
        if(entry.mode==='failure')event(entry.response,{type:'error',error:{code:'QA_MODEL_ERROR',message:'隔离测试：服务拒绝本次生成'}});
        else if(entry.mode==='malformed')entry.response.write('data: invalid-json\r\n\r\n');
        else if(entry.mode!=='truncated'){event(entry.response,{type:'status',stage:'validate',message:'正在校验题号与范围',current:3,total:3});event(entry.response,{type:'result',result:entry.run});}
        entry.response.end();
      }return json(response,{ok:true});
    }
    if(!url.pathname.startsWith('/api/')){
      const path=resolve(staticRoot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!path.startsWith(staticRoot+sep))return json(response,{error:'Not found'},404);
      try{const bytes=await readFile(path);response.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm'} as Record<string,string>)[extname(path)]||'application/octet-stream'});response.end(bytes);}catch{return json(response,{error:'Not found'},404);}return;
    }
    let body:any={};if(request.method!=='GET'){const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const value=Buffer.concat(chunks).toString();if(value)body=JSON.parse(value);}
    if(url.pathname==='/api/bootstrap')return json(response,{settings:DEFAULT_SETTINGS,domains:[{id:'computer',name:'计算机',description:'',sortOrder:0}],categories:[{id:'database',name:'数据库',domainId:'computer',parentId:null,description:'',sortOrder:0}],tags:[],stats:{totalQuestions:1000,generalQuestions:1000,personalQuestions:0,totalPapers:0,totalDocuments:0,favoriteCount:0,dueCount:0,wrongCount:0,typeCounts:{}},ai:{available:true,message:''}});
    if(url.pathname==='/api/exams/sync')return json(response,{attempt:null});
    if(url.pathname==='/api/ai/settings')return json(response,{...DEFAULT_AI_SETTINGS,enabled:true,baseUrl:'http://127.0.0.1',model:'isolated-ui-stream',hasKey:false});
    if(url.pathname==='/api/question-banks')return json(response,[]);
    if(url.pathname==='/api/ai/runs')return json(response,url.searchParams.has('page')?{items:[],total:0,page:1,pageSize:20}:[]);
    if(url.pathname==='/api/ai/paper-plan'||url.pathname==='/api/ai/test'){
      const id=++sequence;requests.push({url:url.pathname,body,accept:String(request.headers.accept||'')});
      if(body.prompt==='http-error')return json(response,{error:{code:'QA_BAD_REQUEST',message:'请求格式测试',details:[{path:'count',message:'题量无效'}]}},400);
      const result=url.pathname==='/api/ai/test'?{ok:true,message:'隔离连接成功'}:run(id);
      if(body.prompt==='json')return json(response,result);
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});response.flushHeaders();
      event(response,{type:'status',stage:'model_start',message:'正在从提示词识别组卷范围',current:1,total:3});
      // Split an SSE frame, a CRLF delimiter and one Chinese UTF-8 character.
      const frame=Buffer.from('data: '+JSON.stringify({type:'delta',text:'{"private_model_reasoning":"SHOULD_NOT_APPEAR","title":"流式生成事务练习","description":"正在生成可读说明'})+'\r\n\r\n');
      const chinese=frame.indexOf(Buffer.from('流'));response.write(frame.subarray(0,chinese+1));
      setTimeout(()=>{if(response.destroyed)return;response.write(frame.subarray(chinese+1,frame.length-1));setTimeout(()=>{if(!response.destroyed)response.write(frame.subarray(frame.length-1));},10);},30);
      waiting.set(id,{response,mode:body.prompt||'success',run:result});
      response.once('close',()=>{if(waiting.delete(id))closed++;});return;
    }
    return json(response,{error:{code:'QA_UNEXPECTED_API',message:`Unexpected fixture request: ${request.method} ${url.pathname}`}},404);
  }catch(error){if(!response.headersSent)json(response,{error:{code:'QA_ERROR',message:String(error)}},500);else response.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log('AI_STREAM_UI_READY '+JSON.stringify({origin:`http://127.0.0.1:${(server.address() as any).port}`}));
async function close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));process.exit();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
