import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const folder=resolve('test-results/choice-editor-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-choice-editor.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;const checks=[],errors=[],unexpectedNetwork=[];
server.stdout.on('data',chunk=>stdout+=chunk);server.stderr.on('data',chunk=>stderr+=chunk);
try{
  for(let tick=0;tick<600&&!stdout.includes('CHOICE_EDITOR_READY ');tick++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
  const line=stdout.split(/\r?\n/).find(value=>value.startsWith('CHOICE_EDITOR_READY '));assert.ok(line,stderr+stdout);
  const {origin}=JSON.parse(line.slice('CHOICE_EDITOR_READY '.length));
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(25000);
  page.on('pageerror',reason=>errors.push(reason.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();unexpectedNetwork.push(url.href);return route.abort();});
  const go=async id=>{await page.goto(origin+'/#/questions/'+id+'/edit');await page.getByRole('button',{name:'保存题目',exact:true}).waitFor();await page.getByRole('textbox',{name:'题干 Markdown',exact:true}).waitFor();};
  const saved=async id=>{await page.getByRole('button',{name:'保存题目',exact:true}).click();await page.waitForURL(url=>url.hash.split('?')[0]==='#/questions/'+id);const response=await page.request.get(origin+'/api/questions/'+id);assert.ok(response.ok());return response.json();};
  const input=(key,prefix='')=>page.getByRole('textbox',{name:prefix+'选项 '+key,exact:true});
  const correct=(key,prefix='')=>page.getByRole('radio',{name:prefix+key+' 为正确答案',exact:true});
  const choice=(key,prefix='')=>page.getByRole('checkbox',{name:prefix+key+' 为正确答案',exact:true});
  const remove=(key,prefix='')=>page.getByRole('button',{name:prefix+'删除选项 '+key,exact:true}).click();
  const labels=async scope=>scope.locator('.option-editor label strong').allTextContents();

  await go('CHOICE-SINGLE');await remove('C');
  assert.deepEqual(await labels(page.locator('#question-editor-form')),['A','B','C']);assert.equal(await input('C').inputValue(),'原选项D');assert.equal(await correct('C').isChecked(),true);assert.equal(await input('D').count(),0);
  await page.getByText('删除后会依次重编号，正确项随选项内容保留。选项变更后，请核对答案与解析中的选项字母。',{exact:true}).waitFor();
  const single=await saved('CHOICE-SINGLE');assert.deepEqual(single.correctAnswers,['C']);assert.deepEqual(single.options.map(option=>option.key),['A','B','C']);assert.equal(single.options[2].text,'原选项D');
  checks.push('普通单选删除C后原D变C，正确答案跟随内容，保存后服务端为C');

  await go('CHOICE-SINGLE');await remove('C');
  assert.equal(await page.getByRole('radio',{checked:true}).count(),0);assert.deepEqual(await labels(page.locator('#question-editor-form')),['A','B']);
  await page.getByRole('button',{name:'增加选项',exact:true}).click();await input('C').fill('新选项C');
  await page.getByRole('button',{name:'增加选项',exact:true}).click();await input('D').fill('新选项D');await correct('B').check();
  const restored=await saved('CHOICE-SINGLE');assert.deepEqual(restored.options.map(option=>option.key),['A','B','C','D']);assert.deepEqual(restored.correctAnswers,['B']);assert.equal(restored.options[2].text,'新选项C');
  checks.push('删除正确项取消选择，新增按C/D顺序补齐，重新选择答案可保存');

  await go('CHOICE-MULTI');await remove('C');assert.equal(await choice('A').isChecked(),true);assert.equal(await choice('C').isChecked(),true);assert.equal(await choice('B').isChecked(),false);
  const multi=await saved('CHOICE-MULTI');assert.deepEqual(multi.correctAnswers,['A','C']);assert.equal(multi.options[2].text,'原选项D');
  checks.push('普通多选删除正确C后只移除原C，保留原A和原D对应的新A/C');

  await go('CHOICE-GROUP');await remove('C','小题1 ');assert.equal(await correct('C','小题1 ').isChecked(),true);assert.equal(await input('C','小题1 ').inputValue(),'原选项D');
  await remove('A','小题2 ');assert.equal(await choice('C','小题2 ').isChecked(),true);assert.equal(await choice('A','小题2 ').isChecked(),false);
  await choice('A','小题2 ').check();await page.locator('.question-part-editor').nth(1).getByRole('button',{name:'增加选项',exact:true}).click();await input('D','小题2 ').fill('组合新D');
  const group=await saved('CHOICE-GROUP');assert.deepEqual(group.parts[0].correctAnswers,['C']);assert.equal(group.parts[0].options[2].text,'原选项D');assert.deepEqual(group.parts[1].correctAnswers,['A','C']);assert.equal(group.parts[1].options[0].text,'原选项B');assert.deepEqual(group.parts[1].options.map(option=>option.key),['A','B','C','D']);
  checks.push('组合小题的单选/多选与普通题一致，删除及添加不会串改其他小题');

  await go('CHOICE-GROUP');await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(folder,'mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  checks.push('390px组合题编辑器没有横向溢出');assert.deepEqual(errors,[]);assert.deepEqual(unexpectedNetwork,[]);checks.push('全程内存数据库、零浏览器异常及意外外网请求');
  const report={passed:checks.length,checks,errors,unexpectedNetwork,database:':memory:'};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(reason){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(reason.stack||reason),checks,errors,unexpectedNetwork,stderr},null,2)+'\n');throw reason;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
