import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerApiDocs } from '../../server/http/openapi.js';
import { registerLibraryRoutes } from '../../server/modules/library/routes.js';
import { registerQuestionBankRoutes } from '../../server/modules/banks/routes.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { paginate } from '../../server/core/pagination.js';

async function fixture(t:test.TestContext,native=false){
 const store=new Store(':memory:');const app=Fastify();t.after(async()=>{await app.close();store.db.close();});
 app.setErrorHandler((error,_req,reply)=>error instanceof ApiError?reply.code(error.status).send({error:{code:error.code}}):reply.code(500).send({error:{code:String(error)}}));
 await registerApiDocs(app,{native});registerLibraryRoutes(app,store);registerQuestionBankRoutes(app,store);registerAiRoutes(app,store);
 for(let i=0;i<25;i++){store.put('documents',`D${i}`,{id:`D${i}`,title:`资料${i.toString().padStart(2,'0')}`,kind:i%2?'书籍':'学习笔记',bodyMarkdown:'正文',format:'markdown',collection:'general',categoryIds:[],tagIds:[],updatedAt:`2026-10-${(i+1).toString().padStart(2,'0')}T00:00:00.000Z`});store.put('question_banks',`B${i}`,{id:`B${i}`,name:`集合${i.toString().padStart(2,'0')}`,description:i%2?'数据库':'网络',questionIds:[]});}
 const get=async(url:string,expected=200)=>{const r=await app.inject({method:'GET',url});assert.equal(r.statusCode,expected,r.body);return r;};return{app,store,get};
}
test('runtime OpenAPI lists registered paths and real Zod request structures with interactive Swagger UI',async t=>{
 const f=await fixture(t);const spec=(await f.get('/api/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.ok(spec.paths['/api/documents']);assert.ok(spec.paths['/api/documents/{id}']);assert.ok(spec.paths['/api/ai/paper-plan']);assert.equal(spec.paths['/api/ai/paper-plan'].post.requestBody.content['application/json'].schema.properties.count.maximum,500);assert.ok(spec.paths['/api/ai/runs/{id}/paper'].post.requestBody.content['application/json'].schema.required.includes('confirmed'));assert.ok(!JSON.stringify(spec).includes('secret-do-not-export'));assert.ok(!spec.paths['/api/docs']);const html=await f.get('/api/docs/');assert.match(html.body,/swagger-ui/);
});
test('native OpenAPI is generated from same route catalog without loading web plugins',async t=>{const f=await fixture(t,true);const spec=(await f.get('/api/openapi.json')).json();assert.ok(spec.paths['/api/ai/grade']);assert.equal(spec.paths['/api/question-banks/{id}'],undefined);assert.ok(spec.paths['/api/questions/bulk-import']);assert.equal(spec.paths['/api/ai/runs'].get.parameters.find((p:any)=>p.name==='pageSize').in,'query');await f.get('/api/docs/',404);});
test('documents paginate filtered results while selectors retain arrays and kinds do not fetch bodies',async t=>{const f=await fixture(t);assert.equal((await f.get('/api/documents')).json().length,25);const docs=(await f.get('/api/documents?page=2&pageSize=10&kind=书籍')).json();assert.equal(docs.total,12);assert.equal(docs.items.length,2);assert.equal(docs.page,2);assert.deepEqual((await f.get('/api/documents/kinds')).json(),['书籍','学习笔记']);await f.get('/api/documents?pageSize=15',400);await f.get('/api/question-banks',404);});
test('pagination bounds and detached pages preserve accurate totals',()=>{const data=[1,2,3];assert.deepEqual(paginate({},data),data);assert.deepEqual(paginate({page:10,pageSize:10},data),{items:[],total:3,page:10,pageSize:10});assert.throws(()=>paginate({pageSize:1000},data),ApiError);});


test('documentation generation never changes runtime request validation or response serialization',async t=>{
 const f=await fixture(t);f.app.post('/api/questions',async request=>({opaque:'preserve me',nested:{unmodeled:42},received:request.body}));
 await f.get('/api/openapi.json');
 const response=await f.app.inject({method:'POST',url:'/api/questions',payload:{custom:'body without documented title'}});
 assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{opaque:'preserve me',nested:{unmodeled:42},received:{custom:'body without documented title'}});
 const invalid=await f.app.inject({method:'POST',url:'/api/documents',payload:{title:''}});assert.equal(invalid.statusCode,400);
});
