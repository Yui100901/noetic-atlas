/** Management workflows on a disposable bank; no private data or remote AI. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const folder=resolve('test-results/quality-management-editor-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-unified-quality.ts'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='',browser,page;const checks=[],errors=[],external=[];
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
try{
 for(let i=0;i<600&&!stdout.includes('UNIFIED_QUALITY_READY ');i++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
 const ready=stdout.split(/\r?\n/).find(line=>line.startsWith('UNIFIED_QUALITY_READY '));assert.ok(ready,stderr);
 const {origin}=JSON.parse(ready.slice('UNIFIED_QUALITY_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(25000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
 const wait=async(fn,label)=>{for(let i=0;i<250;i++){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);};
 const panel=()=>page.getByRole('region',{name:'本题质量问题',exact:true});
 const detail=()=>page.getByRole('region',{name:'质量问题详情',exact:true});
 const issues=async id=>(await api('/api/content-quality/issues?status=all&questionId='+id+'&pageSize=100')).items;
 const questionContent=({study,partStudies,feedbackSummary,...value})=>value;
 const oldAttempt=JSON.stringify((await api('/qa/unified-quality')).attempt);
 async function pair(id){
  const question=await api('/api/questions','POST',{id,title:'顺序处理对照'+id,type:'short_answer',stemMarkdown:'说明本题独立的概念'+id,answerMarkdown:'本题定义与条件'+id,categoryIds:['feedback-python'],sourceRefs:[{label:'待核对的占位链接',url:'https://example.org/'+id}]});
  await api('/api/questions/review','POST',{ids:[id],action:'approve',confirmed:true,expectedUpdatedAt:{[id]:question.updatedAt}});
  await api('/api/question-feedback','POST',{questionId:id,kind:'answer',description:'本题用户反馈，请独立核对并记录处理依据。'});
  const scan=await api('/api/content-quality/scans','POST',{filters:{questionId:id,status:'all'}});await api('/api/content-quality/scans/'+scan.id+'/process','POST',{batchSize:1});
  const rows=await issues(id);assert.equal(rows.length,2);return{scan:rows.find(row=>row.origin==='scan'),feedback:rows.find(row=>row.origin==='feedback')};
 }
 const first=await pair('MANAGE-PAIR1'),second=await pair('MANAGE-PAIR2');
 const qualityReturn='#/content-quality?status=all&origin=feedback&questionId=MANAGE-PAIR1&pageSize=10';
 await page.goto(origin+'/'+qualityReturn);const card=page.locator('.quality-question-item[data-quality-question="MANAGE-PAIR1"]');await card.locator('.quality-summary-issue').first().waitFor();
 assert.equal(await page.locator('.quality-question-item').count(),1);assert.equal(await card.locator('.quality-summary-issue').count(),2);assert.match(await card.innerText(),/规则扫描/);assert.match(await card.innerText(),/用户反馈/);
 assert.equal(await page.getByRole('region',{name:'质量问题详情',exact:true}).count(),0);assert.equal(await page.locator('details.quality-management-tools').evaluate(node=>node.open),false);checks.push('质量主列表仅题目和问题行，同题只出现一次，长证据与工具默认收起');
 await card.locator('[data-quality-issue="'+first.scan.id+'"]').getByRole('link',{name:'详情与处理',exact:true}).click();await page.getByRole('heading',{name:'编辑题目',exact:true}).waitFor();await detail().waitFor();
 assert.ok(page.url().includes('/MANAGE-PAIR1/edit?'));assert.ok(page.url().includes('qualityIssueId='));assert.equal(await page.locator('a.back-link').innerText(),'返回质量管理');
 assert.equal(await page.getByRole('region',{name:'题目详情与参考答案',exact:true}).locator('details').first().evaluate(node=>node.open),true);
 assert.equal(await panel().evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('input[maxlength="300"]'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
 for(const name of ['学习情况','详细历史作答','我的笔记'])assert.equal(await page.getByRole('heading',{name,exact:true}).count(),0);
 checks.push('质量问题详情直达编辑页并定位问题，彩色问题面板排在正文前，答案预览默认展开，无学习卡片');
 async function resolvePair(id,order){
  const before=await api('/api/questions/'+id),row=()=>panel().locator('[data-quality-issue="'+order[0].id+'"]'),sibling=()=>panel().locator('[data-quality-issue="'+order[1].id+'"]');
  const priorColor=await row().evaluate(node=>getComputedStyle(node).borderLeftColor);
  // Prepare both items before saving either one. Refreshing the first must
  // preserve the sibling's independent unsaved note and selected status.
  const siblingNote='这一项单独核查，与前项独立保存结论。';
  await row().getByLabel('本项处理状态',{exact:true}).selectOption('resolved');await row().getByLabel('本项处理依据 / 备注',{exact:true}).fill('已对照当前题面和参考答案核查本问题。');
  await sibling().getByLabel('本项处理状态',{exact:true}).selectOption('confirmed');await sibling().getByLabel('本项处理依据 / 备注',{exact:true}).fill(siblingNote);
  await row().getByRole('button',{name:'保存本项状态',exact:true}).click();
  await wait(async()=>(await issues(id)).find(issue=>issue.id===order[0].id).status==='resolved','first independent issue resolved');
  await wait(async()=>await row().evaluate(node=>node.classList.contains('question-quality-resolved')),'resolved card updated');
  assert.notEqual(await row().evaluate(node=>getComputedStyle(node).borderLeftColor),priorColor);
  assert.equal((await issues(id)).find(issue=>issue.id===order[1].id).status,'open');
  await wait(async()=>await sibling().getByRole('button',{name:'保存本项状态',exact:true}).isEnabled(),'sibling unlocked after refresh');
  assert.equal(await sibling().getByLabel('本项处理依据 / 备注',{exact:true}).inputValue(),siblingNote);assert.equal(await sibling().getByLabel('本项处理状态',{exact:true}).inputValue(),'confirmed');
  await sibling().getByRole('button',{name:'保存本项状态',exact:true}).click();await wait(async()=>(await issues(id)).find(issue=>issue.id===order[1].id).status==='confirmed','sibling independent selected state');
  await wait(async()=>await sibling().getByRole('button',{name:'保存本项状态',exact:true}).isEnabled(),'sibling ready again');await sibling().getByLabel('本项处理状态',{exact:true}).selectOption('resolved');await sibling().getByRole('button',{name:'保存本项状态',exact:true}).click();
  await wait(async()=>(await issues(id)).every(issue=>issue.status==='resolved'),'second independent issue resolved');
  assert.deepEqual(questionContent(await api('/api/questions/'+id)),questionContent(before));
 }
 await resolvePair('MANAGE-PAIR1',[first.scan,first.feedback]);checks.push('先解决扫描项后仍可解决同题反馈，颜色和独立状态即时更新，原题版本不变');
 await page.locator('a.back-link').click();await card.waitFor();assert.equal(new URL(page.url()).hash,qualityReturn);assert.equal(await page.getByLabel('质量问题来源',{exact:true}).inputValue(),'feedback');assert.equal(await page.getByLabel('质量题目每页数量',{exact:true}).inputValue(),'10');checks.push('编辑页返回质量管理保留来源、题号、状态与分页设置');
 await page.goto(origin+'/#/questions/MANAGE-PAIR2/edit?returnTo='+encodeURIComponent('#/content-quality')+'&qualityIssueId='+second.feedback.id);await detail().waitFor();await resolvePair('MANAGE-PAIR2',[second.feedback,second.scan]);checks.push('先解决反馈再解决扫描项同样有效，题下历史处理项继续保留');

 await page.goto(origin+'/#/questions/MANAGE-PAIR2/edit');await panel().waitFor();await wait(async()=>/均已处理/.test(await panel().locator('summary.question-quality-summary').innerText()),'closed history summary');assert.equal(await panel().locator('details.question-quality-disclosure').evaluate(node=>node.open),false);checks.push('全部问题已处理时默认收起，历史仍可展开查看');
 let repaired=await api('/api/questions','POST',{id:'MANAGE-REPAIRED',title:'修订后独立反馈',type:'single_choice',stemMarkdown:'选择整体提交的描述。',options:[{key:'A',text:'全部提交或回滚'},{key:'B',text:'全部提交或回滚'}],correctAnswers:['A']});
 async function scanRepaired(){const value=await api('/api/content-quality/scans','POST',{filters:{questionId:repaired.id}});await api('/api/content-quality/scans/'+value.id+'/process','POST',{batchSize:1});}
 await scanRepaired();const expiredScan=(await issues(repaired.id))[0];repaired=await api('/api/questions/'+repaired.id,'PUT',{...repaired,options:[{key:'A',text:'全部提交或回滚'},{key:'B',text:'允许部分提交'}]});await scanRepaired();const stale=(await issues(repaired.id)).find(issue=>issue.id===expiredScan.id);
 const closed=await api('/api/content-quality/issues/'+stale.id+'/resolve','POST',{status:'resolved',note:'已修正并重新检查重复选项。',expectedUpdatedAt:stale.updatedAt});assert.equal(closed.sourceChanged,true);
 const newFeedback=await api('/api/question-feedback','POST',{questionId:repaired.id,kind:'answer',description:'当前版本的独立用户反馈。'});await page.goto(origin+'/#/questions/'+repaired.id+'/edit');const feedbackRow=panel().locator('[data-quality-issue="'+newFeedback.qualityIssueId+'"]');await feedbackRow.waitFor();const untouched=(await issues(repaired.id)).find(issue=>issue.id===newFeedback.qualityIssueId);
 await feedbackRow.getByRole('button',{name:'保存本项状态',exact:true}).click();await feedbackRow.getByRole('alert').filter({hasText:'请填写本问题的处理依据'}).waitFor();assert.equal((await issues(repaired.id)).find(issue=>issue.id===newFeedback.qualityIssueId).updatedAt,untouched.updatedAt);
 await feedbackRow.getByLabel('本项处理依据 / 备注',{exact:true}).fill('本项用户反馈已独立核对。');await feedbackRow.getByRole('button',{name:'保存本项状态',exact:true}).click();await wait(async()=>(await issues(repaired.id)).every(issue=>issue.status==='resolved'),'current feedback resolves beside expired closed scan');assert.deepEqual((await issues(repaired.id)).find(issue=>issue.id===closed.id),closed);checks.push('历史扫描已解决且证据过期时，新反馈仍能单独处理；空备注明确提示且不发送状态写入');

 for(let i=0;i<14;i++)await api('/api/questions','POST',{id:'REVIEW-M'+String(i).padStart(2,'0'),title:'审核导航验收'+i,type:'single_choice',stemMarkdown:'应该选择哪个定义'+i,options:[{key:'A',text:'定义正确'+i},{key:'B',text:'定义不符'+i}],correctAnswers:['A'],answerMarkdown:'A是参考答案',explanationMarkdown:'核查条件和定义后选择A。',categoryIds:['feedback-python']});
 const reviewReturn='#/questions/review?search='+encodeURIComponent('审核导航验收')+'&domainId=feedback-computer&page=2&pageSize=10';
 await page.goto(origin+'/'+reviewReturn);await page.locator('.review-item').first().waitFor();assert.equal(await page.locator('.review-item details').first().evaluate(node=>node.open),true);assert.match(await page.locator('.review-item').first().innerText(),/A是参考答案/);
 await page.locator('.review-item').first().getByRole('link',{name:'详情与编辑',exact:true}).click();await page.getByRole('heading',{name:'编辑题目',exact:true}).waitFor();
 assert.equal(await page.locator('a.back-link').innerText(),'返回审核管理');const preview=page.getByRole('region',{name:'题目详情与参考答案',exact:true});await preview.waitFor();assert.match(await preview.innerText(),/A是参考答案/);assert.match(await preview.innerText(),/核查条件和定义/);
 await wait(async()=>/未发现问题/.test(await panel().locator('summary.question-quality-summary').innerText()),'empty quality summary');assert.equal(await panel().locator('details.question-quality-disclosure').evaluate(node=>node.open),false);
 const gaps=await page.locator('#question-editor-form .editor-main').evaluate(node=>{const cards=Array.from(node.children).filter(child=>child.classList.contains('card'));return cards.slice(1).map((card,index)=>card.getBoundingClientRect().top-cards[index].getBoundingClientRect().bottom);});assert.ok(gaps.length>=2&&gaps.every(gap=>gap>=16));checks.push('未发现问题时质量面板默认收起，编辑页相邻卡片保持至少16px间距');
 assert.equal(await page.getByText('学习情况',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'开始单题自测',exact:true}).count(),0);checks.push('审核详情直接编辑并展开题面、选项、答案和解析，不出现学习与答题模块');
 const reviewId=decodeURIComponent(new URL(page.url()).hash.split('/')[2]);await page.locator('a.back-link').click();await page.locator('.review-item').first().waitFor();assert.equal(new URL(page.url()).hash,reviewReturn);checks.push('返回审核列表保留领域、搜索、第二页和每页数量');
 await page.locator('.review-item').filter({has:page.locator('a[href*="/'+reviewId+'/edit?"]')}).first().getByRole('link',{name:'详情与编辑',exact:true}).click();await page.getByLabel('标题 *',{exact:true}).waitFor();
 await page.getByLabel('详细解析、追问与常见误区',{exact:true}).fill('编辑后明确记录参考答案A及其适用条件。');assert.equal(await page.getByRole('button',{name:'确认审核通过',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'保存题目',exact:true}).click();await wait(async()=>(await api('/api/questions/'+reviewId)).explanationMarkdown==='编辑后明确记录参考答案A及其适用条件。','management edit saved');assert.ok(page.url().includes('/'+reviewId+'/edit?'));
 await wait(async()=>await page.getByRole('button',{name:'确认审核通过',exact:true}).isEnabled(),'review uses latest saved version');await page.getByRole('button',{name:'确认审核通过',exact:true}).click();await page.getByRole('heading',{name:'审核管理',exact:true}).waitFor();assert.equal((await api('/api/questions/'+reviewId)).status,'published');assert.equal(new URL(page.url()).hash,reviewReturn);checks.push('管理编辑保存后留页，未保存内容阻止审核，按最新版本通过后返回审核列表');

 await page.goto(origin+'/#/content-quality?feedbackId='+second.feedback.feedbackIds[0]);await detail().waitFor();assert.ok(page.url().includes('/MANAGE-PAIR2/edit?'));assert.match(await detail().innerText(),/用户反馈/);
 // Use a quality issue deep link, including a closed item, for mobile evidence.
 await page.goto(origin+'/#/content-quality?issueId='+second.scan.id);await detail().waitFor();assert.ok(page.url().includes('/MANAGE-PAIR2/edit?'));assert.match(await detail().innerText(),/已解决/);checks.push('旧质量问题深链定位编辑页中的已处理问题');
 await page.screenshot({path:resolve(folder,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await delay(350);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(folder,'mobile.png'),fullPage:true});
 assert.equal(JSON.stringify((await api('/qa/unified-quality')).attempt),oldAttempt);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('390px编辑流程无横向溢出，历史卷面不变，无页面异常或外网请求');
 const report={passed:checks.length,checks,errors,external,database:':memory:'};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
