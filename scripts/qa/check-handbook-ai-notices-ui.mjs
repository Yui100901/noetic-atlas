/** Built application, in-memory fixture and loopback AI; never opens the working database. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/handbook-ai-notices');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-question-edit.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;const checks=[],errors=[],external=[];
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
try{
 for(let i=0;i<600&&!stdout.includes('AI_QUESTION_EDIT_READY ');i++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
 const ready=stdout.split(/\r?\n/).find(line=>line.startsWith('AI_QUESTION_EDIT_READY '));assert.ok(ready,stderr);const {origin}=JSON.parse(ready.slice('AI_QUESTION_EDIT_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
 let navigation=0;const go=async path=>{await page.goto(origin+'/?handbook-qa='+ ++navigation+'#/'+path);await page.waitForLoadState('networkidle');};
 const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');await page.screenshot({path:resolve(folder,name+'.png'),fullPage:true});};
 await go('');const card=page.getByRole('region',{name:'本周学习统计',exact:true});await card.locator('[data-week-metric="answers"]').waitFor();
 const week=await api('/api/analytics/weekly?timeZone=Asia%2FShanghai');assert.equal(await card.locator('[data-week-metric="answers"]').innerText(),week.current.summary.answers+'次');assert.equal(week.current.summary.answers,1);
 assert.equal(await page.locator('.page-header a[href^="#/analytics"]').count(),0);
 await page.getByRole('region',{name:'用户使用手册入口',exact:true}).getByRole('link',{name:'打开使用手册',exact:true}).click();
 await page.getByRole('navigation',{name:'手册目录',exact:true}).waitFor();await page.getByRole('heading',{name:'开始使用',exact:true}).waitFor();checks.push('总览本周卡片与周报同口径并显示真实提交，旧顶部统计入口移除，手册卡片可进入');
 const search=()=>page.getByPlaceholder('搜索手册内容',{exact:true});
 await search().fill('Token');await page.getByRole('status').filter({hasText:'找到1个相关章节'}).waitFor();assert.equal(await page.getByRole('heading',{name:'开始使用',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'AI辅助',exact:true}).count(),1);
 await search().fill('没有这个词QAXX');await page.getByRole('heading',{name:'没有找到相关章节',exact:true}).waitFor();
 await page.getByRole('navigation',{name:'手册目录'}).getByRole('button',{name:'题目管理与审核',exact:false}).click();assert.equal(await search().inputValue(),'');
 await page.getByRole('heading',{name:'题目管理与审核',exact:true}).waitFor();await page.waitForFunction(()=>{const r=document.getElementById('题目管理与审核')?.getBoundingClientRect();return r&&r.top>=0&&r.top<innerHeight;});
 checks.push('手册章节搜索、空结果和目录定位有效，目录能清除筛选并滚动到目标章节');
 await page.getByRole('link',{name:'题目字段与质量规则',exact:true}).click();await page.getByRole('link',{name:'返回使用手册',exact:true}).waitFor();assert.ok(decodeURIComponent(page.url()).includes('doc=docs/题目字段与质量规则.md'));await capture('field-rules');
 await page.getByRole('link',{name:'返回使用手册',exact:true}).click();await page.getByRole('navigation',{name:'手册目录'}).waitFor();
 await page.setViewportSize({width:390,height:844});await capture('manual-mobile');await go('');await card.locator('[data-week-metric="answers"]').waitFor();await capture('dashboard-mobile');
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('link',{name:'查看用户使用手册',exact:true}).click();await page.getByRole('navigation',{name:'手册目录'}).waitFor();
 await page.reload();await page.getByRole('navigation',{name:'手册目录'}).waitFor();assert.deepEqual(external,[]);checks.push('相关规则文档在应用内切换并返回，顶部帮助入口有效；390px布局、刷新和内置阅读无外网请求');
 await page.setViewportSize({width:1440,height:1000});
 const aiLinks=()=>page.locator('a[href="#/settings?tab=ai"]');
 const routes=['questions/EDIT-S/edit','questions/EDIT-S','ai','ai?tab=import','ai?tab=documents','ai?tab=history'];
 for(const route of routes){await go(route);assert.equal(await aiLinks().count(),0,'enabled AI configuration link on '+route);}
 assert.equal((await api('/api/ai/settings')).maxTokens,4096);checks.push('AI启用后编辑、单题解析、推荐、普通导入、教材分批和处理记录均隐藏配置入口，已保存4096配置不被新默认覆盖');
 const {hasKey,...current}=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{...current,enabled:false});
 await go('questions/EDIT-S/edit');await page.getByRole('link',{name:'配置 AI 辅助',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'分析当前题目',exact:true}).isDisabled(),true);
 await go('ai');await page.getByRole('link',{name:'配置 AI 辅助',exact:true}).waitFor();assert.equal(await aiLinks().count(),1);assert.equal(await page.getByRole('link',{name:'AI服务配置',exact:true}).count(),0);await go('ai?tab=history');await page.getByRole('link',{name:'AI服务配置',exact:true}).waitFor();assert.equal(await aiLinks().count(),1);
 await page.getByRole('link',{name:'AI服务配置',exact:true}).click();await page.getByLabel('最大输出 Token',{exact:true}).waitFor();assert.equal(await page.getByLabel('最大输出 Token',{exact:true}).inputValue(),'4096');await capture('ai-disabled-settings');
 const {hasKey:unused,...off}=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{...off,enabled:true});await go('ai');assert.equal(await aiLinks().count(),0);checks.push('AI关闭时配置提示恢复且编辑分析禁用，提示能跳到实际配置页，重新开启后再次隐藏');
 const state=await api('/qa/ai-question-edit');assert.equal(state.requests.length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const report={passed:checks.length,checks,errors,external,database:':memory:',provider:'loopback-only',aiCalls:state.requests.length};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
