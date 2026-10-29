/** Entry and import-preview correctness, isolated DB and a loopback model. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),folder=resolve(root,'test-results/task-entry-preview-ui');await mkdir(folder,{recursive:true});
const child=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-workflows.ts'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
const checks=[],errors=[],external=[];
try{
 let ready;for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('AI_WORKFLOWS_READY '));if(line){ready=JSON.parse(line.slice('AI_WORKFLOWS_READY '.length));break;}await delay(100);}assert.ok(ready,stderr);
 const {origin}=ready,{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(url,method='GET',data)=>{const response=await page.request.fetch(origin+url,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
 await page.goto(origin+'/#/questions/import');const entry=page.getByRole('link',{name:'AI辅助转换 PDF / 文本',exact:true});await entry.click();await page.getByLabel('待转换文本',{exact:true}).waitFor();assert.equal(await page.locator('.ai-section-tabs .selected').innerText(),'文件 / 文本辅助导入');checks.push('批量新增的AI转换入口直达文件/文本导入，不落入组题');
 await page.getByLabel('待转换文本',{exact:true}).fill('判断事务是否整体提交，答案正确。');await page.getByRole('button',{name:'分析并生成结构化预览',exact:true}).click();await page.getByRole('button',{name:'确认新增到待审核',exact:true}).waitFor();
 const examples=[
  {title:'判断预览',type:'true_false',stemMarkdown:'判断占位',correctAnswers:['false']},
  {title:'单选预览',type:'single_choice',stemMarkdown:'请选择',options:[{key:'A',text:'甲选项'},{key:'B',text:'乙选项'}],correctAnswers:['B']},
  {title:'多选预览',type:'multiple_choice',stemMarkdown:'请选择多项',options:[{key:'A',text:'甲选项'},{key:'B',text:'乙选项'}],correctAnswers:['A','B']},
  {title:'填空预览',type:'fill_blank',stemMarkdown:'原子性又称{{answer}}',blanks:[{id:'gap',label:'名称',answers:['整体性','原子性'],caseSensitive:true,trim:false}]},
  {title:'简答预览',type:'short_answer',stemMarkdown:'解释概念',answerMarkdown:'简答结论',explanationMarkdown:'解析包含依据与边界'},
  {title:'论述预览',type:'essay',stemMarkdown:'论述边界',answerMarkdown:'论述评分要点'},
  {title:'组合预览',type:'group',stemMarkdown:'公共材料',parts:[{id:'p1',title:'组合判断',type:'true_false',stemMarkdown:'小题判断',correctAnswers:['true']},{id:'p2',title:'组合填空',type:'fill_blank',stemMarkdown:'填入______',blanks:[{id:'gap',answers:['小题标准答案'],trim:true}]}]},
 ];
 await page.getByText('编辑完整题目结构 JSON',{exact:true}).click();const editor=page.getByLabel('AI转换题目JSON',{exact:true});await editor.fill(JSON.stringify(examples));const list=page.locator('.ai-checkbox-list.ai-document-question-previews');await list.locator('details').last().waitFor();
 const bodies=[];for(const item of await list.locator('details').all()){await item.locator('summary').click();bodies.push(item.locator('.ai-document-question-body'));}
 assert.match(await bodies[0].innerText(),/正确判断：错误/);assert.match(await bodies[1].innerText(),/正确选项：B/);assert.match(await bodies[2].innerText(),/正确选项：A、B/);
 assert.match(await bodies[3].innerText(),/整体性 \/ 原子性/);assert.match(await bodies[3].innerText(),/区分大小写 · 保留首尾空白/);assert.doesNotMatch(await bodies[3].innerText(),/\{\{answer\}\}/);
 assert.match(await bodies[4].innerText(),/简答结论/);assert.match(await bodies[4].innerText(),/解析包含依据与边界/);assert.match(await bodies[5].innerText(),/论述评分要点/);assert.match(await bodies[6].innerText(),/正确判断：正确/);assert.match(await bodies[6].innerText(),/小题标准答案/);checks.push('单次导入七种题型完整展示结构化答案，组合小题和填空规则不遗漏，填空占位符已规范化');
 await editor.fill(JSON.stringify([{title:'不完整预览',type:'single_choice',options:[null,{key:'A',text:'合法项'}],parts:[null],correctAnswers:null,blanks:[null]}]));await list.locator('details').evaluateAll(items=>items.forEach(item=>item.open=true));await list.getByText('尚未填写参考答案，请在导入前核对。',{exact:true}).waitFor();assert.deepEqual(errors,[]);checks.push('正在编辑的不完整JSON可以安全预览，不当成已校验题目或造成页面异常');
 const original=await api('/api/questions?status=all');assert.equal(original.total,5);checks.push('核对和修改预览不自动导入或发布题目');

 // Add a reverse-only due task to ensure neither homepage path exposes the word.
 const word=await api('/api/questions','POST',{id:'ENTRY-REVERSE',title:'privateheadword',type:'short_answer',stemMarkdown:'privateheadword',vocabulary:{language:'en',headword:'privateheadword',meaningPrompt:'a synthetic protected reverse prompt',acceptedAnswers:['privateheadword'],pronunciations:[{label:'测试',ipa:'/test/',sourceLabel:'隔离样例',sourceUrl:'https://example.invalid',license:'fixture',method:'manual'}]}});
 await api('/api/questions/review','POST',{ids:[word.id],action:'approve',confirmed:true,expectedUpdatedAt:{[word.id]:word.updatedAt}});
 await api('/api/review-scheduler/card','PATCH',{questionId:word.id,direction:'meaning_to_word',dueAt:new Date(Date.now()-60000).toISOString()});
 await page.goto(origin+'/?entry-probe='+Date.now()+'#/');const due=page.locator('.dashboard-stats a').filter({hasText:'待复习'});await due.waitFor();assert.equal(await due.getAttribute('href'),'#/learning/due');assert.equal(await page.getByRole('link',{name:'开始到期复习',exact:false}).getAttribute('href'),'#/learning/due');await due.click();await page.getByRole('region',{name:'自适应复习队列',exact:true}).waitFor();await page.getByRole('link',{name:'复习任务：看释义想词',exact:true}).click();await page.getByRole('heading',{name:'看释义想词',exact:true}).waitFor();const reading=page.locator('.question-viewer');await reading.getByText('a synthetic protected reverse prompt',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('main').innerText(),/privateheadword/);checks.push('首页两个到期入口进入真实方向队列，逆向任务不提前显示词头');
 const settings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...settings,reviewScheduling:{...settings.reviewScheduling,strategy:'fixed'}}});await page.goto(origin+'/?entry-probe='+Date.now()+'#/');await page.locator('.dashboard-stats').waitFor();await page.locator('.dashboard-stats a').filter({hasText:'待复习'}).click();await page.getByRole('heading',{name:'待复习',exact:true}).waitFor();assert.equal(await page.getByRole('region',{name:'自适应复习队列',exact:true}).count(),0);checks.push('固定日期策略仍进入相应待复习题集，不误显示FSRS队列');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(resolve(folder,'report.json'),JSON.stringify({passed:checks.length,checks,errors,external,isolated:true},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,stderr},null,2));throw error;}
finally{await browser?.close();child.kill('SIGTERM');}
