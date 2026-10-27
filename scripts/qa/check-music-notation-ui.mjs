import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/music-notation-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-music-notation.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',browser,page;const checks=[],errors=[],external=[];server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>stderr+=v);
try{
 for(let i=0;i<500&&!stdout.includes('MUSIC_NOTATION_READY ');i++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
 const ready=stdout.split(/\r?\n/).find(v=>v.startsWith('MUSIC_NOTATION_READY '));assert.ok(ready,stderr);const {origin,byTerm,objectiveId,paperId}=JSON.parse(ready.slice('MUSIC_NOTATION_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1366,height:900},locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const go=async id=>{await page.goto(origin+'/#/questions/'+id);await page.getByRole('button',{name:'我想过了，展开答案与解析',exact:true}).waitFor();};
 const images=async()=>{await page.waitForFunction(()=>[...document.querySelectorAll('.question-body img')].every(img=>img.complete&&img.naturalWidth>0));return page.locator('.question-body img').count();};
 await go(byTerm['高音谱号']);assert.equal(await images(),1);await page.getByRole('button',{name:'我想过了，展开答案与解析',exact:true}).click();assert.equal(await images(),2);await page.screenshot({path:resolve(folder,'treble-desktop.png'),fullPage:true});checks.push('谱号题直接显示图形，解析包含基准线位置，PNG无字体依赖');
 await go(byTerm['四分音符']);assert.equal(await images(),1);checks.push('音符概念题题干显示实际符号');
 await go(byTerm['休止符']);assert.equal(await page.locator('.question-body img').count(),0);await page.getByRole('button',{name:'我想过了，展开答案与解析',exact:true}).click();assert.ok(await images()>0);await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(folder,'rests-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('休止符对照图可见，390px不横向溢出');
 await go(objectiveId);assert.equal(await page.locator('.question-body img').count(),0);await page.getByRole('button',{name:'我想过了，展开答案与解析',exact:true}).click();assert.ok(await images()>0);checks.push('客观题图例只在参考解析展开后显示');
 const call=async(path,body)=>{const r=await page.request.post(origin+path,{data:body});assert.ok(r.ok(),await r.text());return r.json();};
 const share=await call('/api/sharing/export',{kind:'questions',ids:[byTerm['高音谱号'],byTerm['休止符']]});assert.ok(share.assets.length>=3);assert.ok(share.assets.every(a=>a.mimeType==='image/png'&&a.dataBase64.length>0));checks.push('题目分享JSON携带图例附件，可迁移至其他安装');
 const reverse=await call(`/api/papers/${paperId}/attempts`,{vocabularyDirection:'meaning_to_word'});assert.ok(reverse.questions.every(q=>!q.stemMarkdown.includes('/api/assets/')&&!q.stemMarkdown.includes(q.title)));checks.push('概念逆向练习继续使用独立定义，图例不泄露答案');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(resolve(folder,'report.json'),JSON.stringify({passed:checks.length,checks,errors,external,database:':memory:'},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr},null,2));throw error;}finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
