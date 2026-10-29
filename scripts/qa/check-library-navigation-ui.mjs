import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/library-navigation-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-library-navigation.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;const checks=[],errors=[];server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>stderr+=v);
try{
 for(let count=0;count<600&&!stdout.includes('LIBRARY_NAVIGATION_READY ');count++){if(server.exitCode!==null)throw Error(stderr);await delay(100);}
 const line=stdout.split(/\r?\n/).find(v=>v.startsWith('LIBRARY_NAVIGATION_READY '));assert.ok(line,stderr);const {origin}=JSON.parse(line.slice('LIBRARY_NAVIGATION_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));
 const filters=new URLSearchParams({domainId:'GEO-QA',categoryId:'HYDRO-QA',tagIds:'WATER-QA',type:'fill_blank',difficulty:'2',depth:'2',frequency:'3',search:'水文',page:'2',pageSize:'20'});
 await page.goto(origin+'/#/questions?'+filters);await page.getByText('找到 58 道题目',{exact:true}).waitFor();
 const libraryUrl=page.url(),first=page.locator('.question-title').first(),firstTitle=await first.textContent();
 await first.click();await page.getByRole('link',{name:'返回题库',exact:true}).waitFor();
 assert.ok(page.url().includes('returnTo='));const questionBody=page.locator('.question-body');assert.ok((await questionBody.textContent()).includes('＿＿＿＿＿＿'));assert.equal(await questionBody.locator('code').filter({hasText:'{{answer}}'}).first().textContent(),'{{answer}}');
 checks.push('筛选后的填空题显示横线，同时保留行内模板代码');
 await page.getByRole('link',{name:'返回题库',exact:true}).click();await page.getByText('找到 58 道题目',{exact:true}).waitFor();assert.equal(page.url(),libraryUrl);assert.equal(await page.locator('.question-title').first().textContent(),firstTitle);checks.push('题目返回保留领域、分类、标签、题型、D/L/F、关键词、页码和每页数量');
 await page.locator('.question-title').first().click();await page.getByRole('link',{name:'返回题库',exact:true}).waitFor();await page.goBack();await page.getByText('找到 58 道题目',{exact:true}).waitFor();assert.equal(page.url(),libraryUrl);checks.push('浏览器后退同样恢复原筛选和分页');
 await page.reload();await page.getByText('找到 58 道题目',{exact:true}).waitFor();assert.equal(await page.locator('.question-title').first().textContent(),firstTitle);checks.push('刷新和直接访问题库地址可恢复筛选');
 await page.getByRole('button',{name:'题库管理',exact:true}).click();await page.getByRole('menuitem',{name:'质量管理',exact:true}).click();await page.getByRole('heading',{name:'质量管理',exact:true}).waitFor();assert.match(new URL(page.url()).hash,/^#\/content-quality/);await page.getByRole('region',{name:'质量题目列表',exact:true}).waitFor();checks.push('题库显眼入口可以打开全库质量工作台');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(folder,'quality-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('390px页面无横向溢出');
 assert.deepEqual(errors,[]);await writeFile(resolve(folder,'report.json'),JSON.stringify({passed:checks.length,checks,errors,database:':memory:'},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,stderr},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
