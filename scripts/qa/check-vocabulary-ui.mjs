/** Set-level vocabulary directions; every action uses an isolated memory fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/vocabulary-ui');
await mkdir(output,{recursive:true});
const{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const fixture=`import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {parse,questionSchema} from './server/core/validation.ts';
import {buildPaper} from './server/modules/practice/service.ts';
import {exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:');
const readings={en:{language:'en',headword:'abandon',meaningPrompt:'放弃；遗弃；离弃',acceptedAnswers:['abandon'],pronunciations:[{label:'英式（RP）',ipa:'/əˈbændən/',sourceLabel:'Isolated source',sourceUrl:'https://example.org/ipa-uk',license:'GPL-3.0',method:'source'},{label:'美式（GA）',ipa:'/əˈbændən/',sourceLabel:'Isolated source',sourceUrl:'https://example.org/ipa-us',license:'MIT',method:'source'}]},ja:{language:'ja',headword:'学校',meaningPrompt:'供学生学习的机构',acceptedAnswers:['学校','がっこう'],pronunciations:[{label:'假名 / 罗马音',kana:'がっこう',romaji:'gakkou',sourceLabel:'JMdict; rule-based transliteration',sourceUrl:'https://www.edrdg.org/jmdict/j_jmdict.html',license:'CC-BY-SA-4.0',method:'transliteration'}]}};
const en={...parse(questionSchema,{id:'QA-EN',title:'abandon',type:'short_answer',stemMarkdown:'abandon：解释词义。',answerMarkdown:'放弃；遗弃',explanationMarkdown:'I will abandon that plan. 关联词：abandoned',status:'published'}),id:'QA-EN'};
const ja={...en,id:'QA-JA',title:'学校｜日语单词',stemMarkdown:'学校：解释词义。',answerMarkdown:'学校',explanationMarkdown:'がっこう：学生が学校へ行く。'};
staging.put('questions',en.id,en);staging.put('questions',ja.id,ja);
const paper=buildPaper(staging,{id:'QA-LEGACY-WORDLIST',title:'旧词表读音补充',description:'Original snapshot remains immutable',mode:'manual',questionIds:[en.id,ja.id]});staging.put('papers',paper.id,paper);
staging.put('questions',en.id,{...en,vocabulary:readings.en});staging.put('questions',ja.id,{...ja,vocabulary:readings.ja});
const vocabularyPaper=buildPaper(staging,{id:'QA-VOCABULARY-SET',title:'高频词汇双向练习',description:'练习方向保存在本次作答',mode:'manual',practiceKind:'vocabulary',questionIds:[en.id,ja.id],scoring:{enabled:false}});staging.put('papers',vocabularyPaper.id,vocabularyPaper);
const normal={...en,id:'QA-PLAIN',title:'普通概念题',stemMarkdown:'解释幂等。',answerMarkdown:'重复操作仍为同一效果。',explanationMarkdown:'普通题用于确保词汇随机池不会混入通用知识。'};staging.put('questions',normal.id,normal);
const app=await buildApp({databasePath:':memory:',seedPath:'no-vocabulary-ui-seed',staticRoot:'dist/web',logger:false});
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(staging)}});assert.ok(imported.statusCode<400,imported.body);staging.db.close();
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('VOCABULARY_READY '+JSON.stringify({origin,paperId:paper.id,vocabularyPaperId:vocabularyPaper.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page,acceptDialog=true;
server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>stderr=(stderr+v).slice(-10000));
const checks=[],errors=[],externalRequests=[];
try{
  let state;
  for(let i=0;i<300;i++){if(server.exitCode!==null)throw Error('Fixture failed: '+stderr);const line=stdout.split(/\r?\n/).find(s=>s.startsWith('VOCABULARY_READY '));if(line){state=JSON.parse(line.slice('VOCABULARY_READY '.length));break;}await delay(100);}
  assert.ok(state,stderr);const{origin}=state;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{const accept=acceptDialog;acceptDialog=true;void(accept?dialog.accept():dialog.dismiss());});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();externalRequests.push(url.origin);return route.abort();});
  const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.status()<400,path+': '+await response.text());return response.json();};
  const go=async(path)=>{await page.goto(origin+'/?vocabulary-ui-qa='+Date.now()+'#/'+path);await page.waitForLoadState('networkidle');};
  const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'document overflow');
  const capture=async name=>{await noOverflow();await page.screenshot({path:resolve(output,name+'.png'),fullPage:true});};

  const openSet=async()=>{await go('papers/'+state.vocabularyPaperId);await page.getByRole('button',{name:'开始练习',exact:true}).waitFor();};
  const startFresh=async(direction)=>{await openSet();await page.getByRole('button',{name:'开始练习',exact:true}).click();const drafts=page.getByRole('dialog',{name:'继续之前的作答？',exact:true});const setup=page.getByRole('dialog',{name:'开始词汇练习',exact:true});await drafts.or(setup).first().waitFor();if(await drafts.isVisible())await drafts.getByRole('button',{name:'重新答题',exact:true}).click();await setup.waitFor();await setup.locator('input[value="'+direction+'"]').check();await setup.getByRole('button',{name:'开始本次练习',exact:true}).click();await page.waitForURL(/#\/attempts\//);await page.waitForLoadState('networkidle');return decodeURIComponent(page.url().split('/').pop());};
  await go('questions/QA-EN');await page.getByLabel('词语读音').waitFor();assert.match(await page.getByLabel('词语读音').innerText(),/英式（RP）[\s\S]*美式（GA）/);assert.equal(await page.getByRole('button',{name:'选择词汇练习方向',exact:true}).count(),0);await page.getByRole('button',{name:'开始单题自测',exact:true}).waitFor();await capture('single-card-no-direction');
  const actions=()=>page.getByRole('button',{name:'题目操作',exact:true});
  await actions().focus();await page.keyboard.press('ArrowDown');await page.getByRole('menuitem',{name:'分享题目',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await actions().getAttribute('aria-expanded'),'false');
  await actions().click();await page.getByRole('menuitem',{name:'分享题目',exact:true}).click();const share=page.getByRole('dialog',{name:'分享内容',exact:true});await share.waitFor();await share.getByRole('button',{name:'关闭',exact:true}).click();
  acceptDialog=false;await actions().click();await page.getByRole('menuitem',{name:'删除题目',exact:true}).click();assert.equal((await api('/api/questions/QA-EN')).status,'published');
  checks.push('单题仅保留普通自测，词汇方向入口已移除；原操作菜单和读音仍可用');

  await go('papers/'+state.paperId);await page.getByLabel('查看题目：abandon',{exact:true}).click();const reading=page.locator('main');await reading.getByLabel('词语读音').waitFor();await reading.getByText('读音补充来自当前词卡；题目正文仍为题集快照。',{exact:true}).waitFor();await reading.getByRole('link',{name:'下一题',exact:true}).click();await reading.getByText('gakkou',{exact:true}).waitFor();await reading.getByRole('link',{name: /^返回题集(?:\s|$)/}).click();
  assert.equal((await api('/api/papers/'+state.paperId+'/questions/QA-EN')).vocabulary,undefined);checks.push('旧词表只读补充读音，题集内上下题和历史快照保留');

  await go('papers/new/manual');await page.getByLabel('题集类型',{exact:true}).selectOption('vocabulary');await page.getByLabel('题集名称 *',{exact:true}).fill('手动创建词汇题集');await page.getByRole('checkbox',{name:'选择 QA-EN',exact:true}).check();await page.getByRole('checkbox',{name:'选择 QA-JA',exact:true}).check();await page.getByRole('button',{name:'创建题集',exact:true}).click();await page.waitForURL(/#\/papers\/[^/]+$/);const createdId=decodeURIComponent(page.url().split('/').pop());assert.equal((await api('/api/papers/'+createdId)).practiceKind,'vocabulary');await page.getByText('词汇题集 · 双向练习',{exact:true}).waitFor();
  await go('papers/'+createdId+'/edit');assert.equal(await page.getByLabel('题集类型',{exact:true}).inputValue(),'vocabulary');await page.getByRole('button',{name:'保存题集',exact:true}).click();await page.waitForURL(/#\/papers\/[^/]+$/);checks.push('手动创建与编辑可设置词汇题集属性，保存后保留，详情有双向练习标识');

  await go('papers/new/random');await page.getByLabel('题集类型',{exact:true}).selectOption('vocabulary');await page.getByLabel('题集名称 *',{exact:true}).fill('随机词汇题集草稿');await page.getByRole('button',{name:'保存组题草稿',exact:true}).click();await page.getByText(/组题草稿已保存/).waitFor();await go('papers');await go('papers/new/random');const authoring=page.getByRole('dialog',{name:'继续组题草稿',exact:true});await authoring.waitFor();await authoring.getByRole('button',{name:/随机词汇题集草稿/}).click();assert.equal(await page.getByLabel('题集类型',{exact:true}).inputValue(),'vocabulary');await page.getByLabel('题目数量',{exact:true}).fill('2');await page.getByRole('button',{name:'创建题集',exact:true}).click();await page.waitForURL(/#\/papers\/[^/]+$/);const randomId=decodeURIComponent(page.url().split('/').pop());const randomPaper=await api('/api/papers/'+randomId);assert.equal(randomPaper.practiceKind,'vocabulary');assert.equal(randomPaper.questionCount,2);assert.equal(randomPaper.questionIds.includes('QA-PLAIN'),false);checks.push('组题草稿保存并恢复词汇属性，随机词汇题集只抽词卡不混入普通题');

  const forwardId=await startFresh('word_to_meaning');let forward=await api('/api/attempts/'+forwardId);assert.equal(forward.vocabularyDirection,'word_to_meaning');assert.equal(forward.questions[0].type,'short_answer');await page.getByLabel('我的回答',{exact:true}).first().fill('初步释义');await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.getByText('草稿已保存',{exact:true}).first().waitFor();await openSet();await page.getByRole('button',{name:'开始练习',exact:true}).click();const draftModal=page.getByRole('dialog',{name:'继续之前的作答？',exact:true});await draftModal.getByText(/顺向 · 看单词想释义/).waitFor();await draftModal.locator('.draft-option').first().click();await page.waitForURL(new RegExp(forwardId));assert.equal(await page.getByLabel('我的回答',{exact:true}).first().inputValue(),'初步释义');assert.equal((await api('/api/attempts/'+forwardId)).vocabularyDirection,'word_to_meaning');await capture('set-forward-draft');checks.push('词汇题集顺向练习可保存并续答原草稿，方向与原回答不变');

  const reverseId=await startFresh('meaning_to_word');const active=await api('/api/attempts/'+reverseId);assert.equal(active.vocabularyDirection,'meaning_to_word');assert.equal(active.source,'paper');assert.equal(active.questions.length,2);for(const q of active.questions){assert.equal(q.vocabulary,undefined);assert.equal(q.blanks[0].answers,undefined);}
  for(const hidden of ['abandon','学校','がっこう','gakkou','əˈbændən','关联词'])assert.equal((await page.locator('body').innerText()).includes(hidden),false,'reverse leaked '+hidden);
  assert.equal(await page.getByLabel('词语读音').count(),0);assert.equal(await page.getByLabel('我的学习笔记',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'查看参考答案',exact:false}).count(),0);await capture('set-reverse-hidden');
  await page.getByLabel('1. 词语',{exact:true}).nth(0).fill('Abandon');await page.getByLabel('1. 词语',{exact:true}).nth(1).fill('がっこう');await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.getByText('客观题答对 2 / 2 题',{exact:true}).waitFor();const done=await api('/api/attempts/'+reverseId);assert.equal(done.answerStates['QA-EN'],'correct');assert.equal(done.answerStates['QA-JA'],'correct');assert.equal((await api('/api/questions/QA-EN/statistics')).correct,1);await page.locator('.attempt-answer').first().locator(':scope > summary').click();await page.getByLabel('词语读音').first().waitFor();await capture('set-reverse-result');checks.push('整集逆向不暴露原词/读音/例句，英日填词自动判对，归原题统计并可查看解析');

  await openSet();await page.getByRole('tab',{name:'历史答题',exact:true}).click();await page.getByText(/逆向 · 看释义想单词/).waitFor();await page.getByRole('tab',{name:'作答草稿',exact:true}).click();await page.getByText(/顺向 · 看单词想释义/).waitFor();checks.push('题集历史与草稿列表显示各次练习方向');

  await page.setViewportSize({width:390,height:844});await openSet();await page.getByRole('button',{name:'选择练习模式',exact:true}).click();await page.getByRole('menuitem',{name:'考试模式',exact:true}).click();const exam=page.getByRole('dialog',{name:'开始限时考试',exact:true});await exam.locator('input[value="meaning_to_word"]').check();await exam.getByLabel('考试时长（分钟）',{exact:true}).fill('1');await capture('set-direction-exam-mobile');await exam.getByRole('button',{name:'开始考试',exact:true}).click();await page.waitForURL(/#\/attempts\//);const examId=decodeURIComponent(page.url().split('/').pop());const examData=await api('/api/attempts/'+examId);assert.equal(examData.practiceMode,'exam');assert.equal(examData.vocabularyDirection,'meaning_to_word');await noOverflow();await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.getByText('客观题答对 0 / 2 题',{exact:true}).waitFor();await openSet();await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.getByRole('dialog',{name:'继续之前的作答？',exact:true}).getByRole('button',{name:'重新答题',exact:true}).click();await page.getByRole('dialog',{name:'开始词汇练习',exact:true}).waitFor();await capture('set-direction-mobile');checks.push('390px可选择整集顺逆向，考试方向与倒计时保留，提前交卷后恢复其他功能');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);const report={passed:checks.length,checks,errors,externalRequests,isolated:true,databasePath:':memory:'};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}


