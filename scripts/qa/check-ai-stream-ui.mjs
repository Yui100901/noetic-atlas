import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/ai-stream-ui');await mkdir(folder,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-stream.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',stderr='',browser;
server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-10000));
const checks=[],pageErrors=[];
try{
  let origin;for(let i=0;i<300;i++){if(server.exitCode!==null)throw Error(stderr);const line=output.split(/\r?\n/).find(line=>line.startsWith('AI_STREAM_UI_READY '));if(line){({origin}=JSON.parse(line.slice('AI_STREAM_UI_READY '.length)));break;}await delay(100);}assert.ok(origin,stderr);
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:940}});page.on('pageerror',error=>pageErrors.push(error.message));page.setDefaultTimeout(15000);
  const state=async()=>(await page.request.get(origin+'/qa/state')).json();const release=async()=>{await page.request.post(origin+'/qa/release');};
  const generate=page.getByRole('button',{name:'生成推荐组卷预览',exact:true});
  await page.goto(origin+'/#/ai',{waitUntil:'domcontentloaded',timeout:60000});await page.getByLabel('AI组卷要求').fill('计算机数据库基础题，推荐2题');
  assert.equal(await page.getByLabel('推荐题量（组合题整组计）',{exact:true}).inputValue(),'');
  await generate.click();await page.getByLabel('AI生成中预览',{exact:true}).getByText('流式生成事务练习',{exact:true}).waitFor();
  const first=await state();assert.equal(first.requests.length,1);assert.equal(first.requests[0].accept,'text/event-stream');assert.equal(Object.hasOwn(first.requests[0].body,'count'),false);assert.deepEqual(first.requests[0].body.filters,{});
  assert.equal(await page.locator('.ai-plan-selection>li').count(),0);assert.ok(await page.getByRole('button',{name:'取消本次处理',exact:true}).isVisible());
  assert.equal(await page.getByLabel('AI生成中预览').getByText('SHOULD_NOT_APPEAR',{exact:false}).count(),0);checks.push('提示词单独组卷，无默认硬筛选或题量；SSE半帧、UTF-8分块、CRLF分块实时预览且不显示非正文推理字段');
  await page.waitForTimeout(1100);assert.match(await page.getByLabel('AI处理进度').innerText(),/已用时 [1-9]\d* 秒/);await release();
  await page.getByRole('button',{name:'确认创建练习卷',exact:true}).waitFor();assert.equal(await page.locator('.ai-plan-selection>li').count(),2);assert.ok(await page.getByText('可用范围 1,000 题 · 检索命中 400 题 · 本次模型审阅 360 题 / 3 批',{exact:true}).isVisible());
  await page.getByText('查看本次工作步骤',{exact:true}).click();assert.ok(await page.getByText('正在校验题号与范围',{exact:true}).count());checks.push('完成后显示校验结果、真实耗时、检索范围与工作步骤');
  await page.locator('.ai-plan-expand').first().scrollIntoViewIfNeeded();assert.match(page.url(),/#\/ai$/);await page.screenshot({path:resolve(folder,'desktop-completed.png')});
  const oldTitle=await page.getByLabel('练习卷名称',{exact:true}).inputValue();
  await page.getByLabel('AI组卷要求').fill('failure');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI生成中预览').waitFor();await release();
  await page.getByRole('alert').filter({hasText:'隔离测试：服务拒绝本次生成'}).waitFor();assert.equal(await page.getByLabel('练习卷名称',{exact:true}).inputValue(),oldTitle);assert.ok(await page.getByText('以下为上次已完成的推荐，本次处理完成后才会替换。',{exact:true}).isVisible());checks.push('流式业务错误保留原完成结果，不把未完成预览作为新结果');
  await page.getByLabel('AI组卷要求').fill('cancel');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI生成中预览').waitFor();await page.getByRole('button',{name:'取消本次处理',exact:true}).click();
  await page.getByText('已取消本次处理，未应用未完成结果',{exact:true}).waitFor();assert.equal(await page.getByLabel('练习卷名称',{exact:true}).inputValue(),oldTitle);await release();assert.equal(await page.getByLabel('练习卷名称',{exact:true}).inputValue(),oldTitle);checks.push('取消关闭流并忽略迟到结果，保留上次预览');
  for(const mode of ['truncated','malformed']){await page.getByLabel('AI组卷要求').fill(mode);await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI生成中预览').waitFor();await release();await page.getByRole('alert').waitFor();assert.equal(await page.getByLabel('练习卷名称',{exact:true}).inputValue(),oldTitle);}
  checks.push('缺失最终结果与损坏JSON帧均按失败处理');
  await page.getByLabel('AI组卷要求').fill('http-error');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByRole('alert').filter({hasText:'请求格式测试：count：题量无效'}).waitFor();checks.push('非SSE的HTTP错误保留结构化校验详情');
  await page.getByLabel('AI组卷要求').fill('json');await page.getByLabel('推荐题量（组合题整组计）',{exact:true}).fill('400');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI处理进度').getByText('处理完成，结果已校验',{exact:true}).waitFor();
  assert.notEqual(await page.getByLabel('练习卷名称',{exact:true}).inputValue(),oldTitle);assert.equal((await state()).requests.at(-1).body.count,400);checks.push('JSON响应回退可用，手动题量400允许提交且不受旧300候选或100题限制');
  await page.getByLabel('推荐题量（组合题整组计）',{exact:true}).fill('501');assert.equal(await page.getByRole('button',{name:'重新推荐',exact:true}).isDisabled(),true);await page.getByLabel('手动指定题量',{exact:true}).uncheck();assert.equal(await page.getByRole('button',{name:'重新推荐',exact:true}).isEnabled(),true);checks.push('500上限前端校验，数量可随时恢复提示词自动模式');
  await page.getByText('高级筛选：手动限定候选范围（可选）',{exact:true}).click();await page.getByLabel('知识领域',{exact:true}).selectOption('computer');await page.getByLabel('最低难度',{exact:true}).selectOption('2');await page.getByLabel('AI组卷要求').fill('json');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI处理进度').getByText('处理完成，结果已校验',{exact:true}).waitFor();assert.deepEqual((await state()).requests.at(-1).body.filters,{domainId:'computer',difficultyMin:2});checks.push('显式高级筛选准确传递，未操作控件不添加隐含条件');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'清空所有手动筛选',exact:true}).click();await page.getByLabel('AI组卷要求').fill('mobile');await page.getByRole('button',{name:'重新推荐',exact:true}).click();await page.getByLabel('AI生成中预览').waitFor();
  await page.waitForFunction(()=>document.querySelector('.sidebar')?.getBoundingClientRect().right<=1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByRole('button',{name:'取消本次处理',exact:true}).click();await page.screenshot({path:resolve(folder,'mobile-stream.png')});checks.push('390px实时进度、取消与筛选界面无横向溢出');
  await page.goto(origin+'/#/settings?tab=ai');await page.getByRole('button',{name:'测试已保存的配置',exact:true}).click();await page.getByLabel('AI生成中预览').waitFor();await release();await page.getByText('隔离连接成功',{exact:true}).waitFor();checks.push('设置连通性测试也展示流式工作进度并显示最终成功');
  assert.deepEqual(pageErrors,[]);checks.push('无未捕获浏览器错误');const report={passed:checks.length,checks,pageErrors,requests:(await state()).requests,database:'none',provider:'controlled-loopback-HTTP'};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,pageErrors,server:stderr},null,2)+'\n');throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
