/** Native Tab focus must stay above shared sticky save bars on long editors. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startBrowserHarness} from './helpers/browser-harness.mjs';

let harness,page,folder;let errors=[],external=[];const focusResults=[];
try{

 harness=await startBrowserHarness({name:'form-save-bar-focus-ui'});({page,folder,errors,external}=harness);const {origin}=harness.state;
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:844});
  for(const [route,field,preceding,region] of [
    ['questions/new','参考来源','详细解析、追问与常见误区','题目保存操作'],
    ['documents/new','资料简介','出版年份 / 版本','资料保存操作'],
    ['settings','单张图片上限（MiB）','单份MD / PDF上限（MiB）','系统配置保存操作']
  ]){
    await page.goto(origin+'/#/'+route);
    const target=page.getByLabel(field,{exact:true});await target.waitFor();
    const bar=page.getByRole('region',{name:region,exact:true});await bar.waitFor();
    if(route==='questions/new'){
      const prev=page.getByLabel(preceding,{exact:true});await prev.focus();await page.keyboard.press('Tab');
    }else{await page.getByLabel(preceding,{exact:true}).focus();await page.keyboard.press('Tab');}
    // Number inputs and Markdown toolbars may add keyboard stops. Follow actual
    // Tab order rather than assuming the next visual field is one Tab away.
    for(let i=0;i<20&&!(await target.evaluate(el=>document.activeElement===el));i++)await page.keyboard.press('Tab');
    const state=await target.evaluate(el=>({active:document.activeElement===el,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));
    const box=await bar.boundingBox();focusResults.push({width,route,field,...state,barTop:box.y,barHeight:box.height,covered:state.bottom>box.y+1});
    await page.screenshot({path:resolve(folder,'focus-'+route.split('/')[0]+'-'+width+'.png'),fullPage:false});
  }
 }
 console.log(JSON.stringify({focusResults,errors}));assert.equal(focusResults.length,9);for(const result of focusResults){assert.equal(result.active,true,JSON.stringify(result));assert.equal(result.covered,false,JSON.stringify(result));assert.ok(result.top>=0,JSON.stringify(result));}assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(resolve(folder,'focus-report.json'),JSON.stringify({focusResults,errors},null,2));
}catch(error){await harness?.captureFailure(error,{focusResults});throw error;}
finally{await harness?.close();}
