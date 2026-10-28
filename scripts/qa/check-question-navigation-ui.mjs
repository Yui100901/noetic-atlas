/** Unsaved question/text protection uses actual routes and a disposable memory fixture. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/question-navigation-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-question-edit.ts'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='',browser,page,acceptDialog=false;const checks=[],errors=[],external=[],dialogs=[],writes=[];
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
try{
 for(let i=0;i<600&&!stdout.includes('AI_QUESTION_EDIT_READY ');i++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
 const ready=stdout.split(/\r?\n/).find(line=>line.startsWith('AI_QUESTION_EDIT_READY '));assert.ok(ready,stderr);const {origin}=JSON.parse(ready.slice('AI_QUESTION_EDIT_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push(dialog.message());void(acceptDialog?dialog.accept():dialog.dismiss());});
 page.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method())&&/^\/api\/(questions(?:\/[^/]+)?|quick-practice)$/.test(new URL(request.url()).pathname))writes.push({method:request.method(),path:new URL(request.url()).pathname});});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
 const question=id=>api('/api/questions/'+id),title=()=>page.getByLabel('标题 *',{exact:true}),notes=()=>page.getByLabel('我的学习笔记',{exact:true});
 let navigation=0;const go=async path=>{acceptDialog=true;await page.goto(origin+'/?qnav='+ ++navigation+'#/'+path);await page.waitForLoadState('networkidle');acceptDialog=false;};
 const wait=async(fn,label)=>{for(let i=0;i<150;i++){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);};
 async function cancelLink(link,expected){const count=dialogs.length,location=page.url();await link.click();await wait(()=>dialogs.length>count,'leave dialog');assert.match(dialogs.at(-1),expected);assert.equal(page.url(),location);}
 const pending=await question('EDIT-P');
 await go('questions/review');await page.getByRole('link',{name:pending.title,exact:true}).click();await title().waitFor();await title().fill('未保存的题干标题');
 await cancelLink(page.getByRole('link',{name:'管理领域、分类与标签',exact:false}),/题目修改尚未保存/);assert.equal(await title().inputValue(),'未保存的题干标题');
 const backDialogs=dialogs.length;await page.evaluate(()=>history.back());await wait(()=>dialogs.length>backDialogs,'back guard');await delay(250);assert.equal(await title().inputValue(),'未保存的题干标题');assert.ok(page.url().includes('/edit?returnTo='));assert.equal((await question('EDIT-P')).title,pending.title);
 checks.push('编辑正文或归类前离开会确认，取消侧栏/管理链接及浏览器返回均保留未保存表单和管理返回地址');
 const beforeSaveDialogs=dialogs.length;await page.getByRole('button',{name:'保存题目',exact:true}).click();await wait(async()=>(await question('EDIT-P')).title==='未保存的题干标题','saved pending edit');await wait(async()=>!(await page.getByRole('button',{name:'保存题目',exact:true}).isDisabled()),'save settled');assert.equal(dialogs.length,beforeSaveDialogs);assert.ok(page.url().includes('/edit?returnTo='));
 await title().fill('第二次未保存的标题');await cancelLink(page.getByRole('link',{name:'返回审核管理',exact:true}),/题目修改尚未保存/);acceptDialog=true;await page.getByRole('link',{name:'返回审核管理',exact:true}).click();await page.getByRole('heading',{name:'审核管理',exact:true}).waitFor();acceptDialog=false;
 checks.push('管理保存正常完成不被导航保护误拦，留在编辑页后再次修改仍受保护，确认后可返回审核');

 await go('questions/EDIT-P/edit');const ai=page.getByRole('region',{name:'AI辅助编辑',exact:true});await ai.getByRole('button',{name:'分析当前题目',exact:true}).click();await ai.locator('[data-edit-suggestion="s-title"]').getByRole('button',{name:'应用本条建议',exact:true}).click();
 await cancelLink(page.getByRole('link',{name:'管理领域、分类与标签',exact:false}),/题目修改尚未保存/);assert.equal(await title().inputValue(),'事务整体提交与回滚');await ai.locator('[data-edit-suggestion="s-title"]').getByRole('button',{name:'撤回本条修改',exact:true}).click();const noDirtyDialogs=dialogs.length;await page.getByRole('link',{name:'管理领域、分类与标签',exact:false}).click();await wait(()=>page.url().includes('#/taxonomy'),'taxonomy opened');assert.equal(dialogs.length,noDirtyDialogs);
 checks.push('应用AI建议视为未保存编辑，取消离开保留建议；撤回到原内容后不再出现冗余离开确认');

 await go('questions/new');await title().fill('导航保护新题');await page.getByLabel('题干 Markdown',{exact:true}).fill('保存新题后应该正常展示待审核详情。');await cancelLink(page.getByRole('link',{name:'返回题库',exact:true}),/题目修改尚未保存/);const createdDialogs=dialogs.length;await page.getByRole('button',{name:'保存题目',exact:true}).click();await page.getByRole('heading',{name:'导航保护新题',exact:true}).waitFor();assert.equal(dialogs.length,createdDialogs);assert.ok(!page.url().includes('/new'));
 checks.push('新建题目取消离开不丢内容，成功保存后自动进入详情且不追加丢弃提示');

 await go('questions/EDIT-S');const originalNotes=await notes().inputValue();await notes().fill(originalNotes+' 本次未保存的笔记。');await cancelLink(page.getByRole('link',{name:'返回题库',exact:true}),/学习笔记尚未保存/);assert.equal(await notes().inputValue(),originalNotes+' 本次未保存的笔记。');
 const quickBefore=writes.filter(value=>value.path==='/api/quick-practice').length,practiceDialogs=dialogs.length;await page.getByRole('button',{name:'开始单题自测',exact:true}).click();await wait(()=>dialogs.length>practiceDialogs,'practice discard prompt');assert.equal(writes.filter(value=>value.path==='/api/quick-practice').length,quickBefore);assert.equal((await question('EDIT-S')).study.notes,originalNotes);
 const history=page.locator('.question-history');await history.getByRole('button',{name:'本题的详细历史作答',exact:false}).click();await history.locator('.question-history-record summary').first().click();await cancelLink(history.getByRole('link',{name:'打开整卷复盘 →',exact:true}),/学习笔记尚未保存/);
 checks.push('普通题目笔记统一保护返回和历史复盘，取消开始自测不会新建悬空作答草稿');
 await page.getByRole('button',{name:'保存笔记',exact:true}).click();await wait(async()=>(await question('EDIT-S')).study.notes.endsWith('本次未保存的笔记。'),'saved notes');const practiceStartDialogs=dialogs.length;await page.getByRole('button',{name:'开始单题自测',exact:true}).click();await page.locator('.attempt-progress').waitFor();assert.ok(page.url().includes('#/attempts/'));assert.equal(dialogs.length,practiceStartDialogs);
 checks.push('笔记保存后开始自测正常跳转，成功写入后的受控导航不会误报保存中');

 await go('questions/EDIT-G');await page.getByLabel('选择小题学习记录',{exact:true}).waitFor();await notes().fill('组合小题未保存笔记');await cancelLink(page.getByRole('link',{name:'返回题库',exact:true}),/学习笔记尚未保存/);assert.equal(await notes().inputValue(),'组合小题未保存笔记');
 checks.push('组合小题笔记由父页统一保护，取消返回保留对应小题输入');

 await api('/api/questions','POST',{id:'NAV-FEEDBACK',title:'仅判分键的反馈预览',type:'true_false',stemMarkdown:'事务是否需要整体提交？',correctAnswers:['true'],answerMarkdown:''});
 await go('questions/NAV-FEEDBACK');await page.getByRole('button',{name:'题目操作',exact:true}).click();await page.getByRole('menuitem',{name:'反馈题目问题',exact:true}).click();const feedback=page.getByRole('dialog',{name:'反馈题目问题',exact:true});await feedback.locator('summary').filter({hasText:'核对本次反馈的当前题目内容'}).click();await feedback.getByRole('heading',{name:'参考答案 · 正确',exact:true}).waitFor();assert.equal(await feedback.getByRole('link',{name:/编辑原题|打开原题/}).count(),0);await feedback.getByRole('button',{name:'取消',exact:true}).click();
 await api('/api/questions','POST',{id:'NAV-FEEDBACK-G',title:'小题反馈独立答案',type:'group',stemMarkdown:'公共事务材料',answerMarkdown:'PARENT_ANSWER_MUST_NOT_REPLACE_PART',parts:[{id:'first',title:'独立判断',type:'true_false',stemMarkdown:'是否允许随意部分提交？',correctAnswers:['false'],answerMarkdown:''},{id:'second',title:'独立简答',type:'short_answer',stemMarkdown:'说明回滚。',answerMarkdown:'撤销未完成事务。'}]});
 await go('questions/NAV-FEEDBACK-G');await page.getByRole('button',{name:'题目操作',exact:true}).click();await page.getByRole('menuitem',{name:'反馈题目问题',exact:true}).click();await feedback.getByLabel('反馈范围',{exact:true}).selectOption('first');await feedback.locator('summary').filter({hasText:'核对本次反馈的当前题目内容'}).click();await feedback.getByRole('heading',{name:'参考答案 · 错误',exact:true}).waitFor();assert.doesNotMatch(await feedback.locator('.feedback-question-context').innerText(),/PARENT_ANSWER_MUST_NOT_REPLACE_PART/);await feedback.getByRole('button',{name:'取消',exact:true}).click();
 checks.push('反馈核对复用完整题面与判分键，小题空解答不错误回退父题答案，也不混入学习或管理操作');
 await go('questions');await page.getByRole('button',{name:/^筛选/}).click();assert.equal(await page.getByLabel('内容属性',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/^筛选/}).getAttribute('aria-expanded'),'true');await go('papers/new/manual');await page.getByRole('button',{name:/^筛选/}).click();await page.getByLabel('内容属性',{exact:true}).waitFor();
 checks.push('题库仅保留顶部内容属性tab，组卷完整筛选仍可使用，展开状态提供可访问性提示');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(resolve(folder,'report.json'),JSON.stringify({passed:checks.length,checks,errors,external,database:':memory:',provider:'loopback-only'},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
