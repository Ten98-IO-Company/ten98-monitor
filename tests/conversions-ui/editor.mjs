import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixtureGuard,evidenceDir,appUrl} from './guard.mjs';
import {readFixture} from './fixture.mjs';
import {launchChromium} from '../helpers/playwright.mjs';

fixtureGuard();const fixture=await readFixture();
const browser=await launchChromium();
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'UTC',serviceWorkers:'block'});
const page=await context.newPage(),errors=[],blocked=[];let stage='login';page.setDefaultTimeout(15_000);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===appUrl&&['GET','HEAD'].includes(request.method()))return route.continue();
  blocked.push('Unexpected browser write or outbound request');return route.abort('blockedbyclient');
});
const panel=page.getByRole('region',{name:'Conversions',exact:true});
const step=n=>panel.getByRole('group',{name:'Step '+n,exact:true});
async function enter(locator){await locator.focus();await locator.press('Enter');}
async function focused(locator){await locator.waitFor();await page.waitForFunction(el=>el===document.activeElement,await locator.elementHandle());}
async function cancel(accept){
  // Leaving a dirty editor asks through the shared ConfirmDialog, driven by keyboard like the rest of this suite.
  await enter(panel.getByRole('button',{name:'Cancel editing',exact:true}));
  const confirmation=page.getByRole('dialog',{name:'Discard your unsaved definition changes?',exact:true});
  assert.match(await confirmation.innerText(),/Your edits to this definition have not been saved/);
  await enter(confirmation.getByRole('button',{name:accept?'Discard changes':'Cancel',exact:true}));
  await confirmation.waitFor({state:'hidden'});
}
async function saved(){const response=await context.request.get(appUrl+'/api/projects/'+fixture.chains.id+'/funnels',{maxRedirects:0,timeout:15_000});assert.equal(response.status(),200);return response.json();}
try{
  const signIn=await context.request.post(appUrl+'/api/auth/sign-in/email',{headers:{Origin:appUrl},data:{email:fixture.owner.email,password:fixture.owner.password},maxRedirects:0,timeout:15_000});assert.equal(signIn.status(),200);
  const before=await saved();await page.goto(appUrl+'/?'+new URLSearchParams({workspace:fixture.workspace.id,project:fixture.chains.id,view:'conversions'}));
  await enter(panel.getByRole('button',{name:'New funnel',exact:true}));await focused(panel.getByRole('heading',{name:'New funnel',exact:true}));
  stage='dirty cancellation confirmation';await panel.getByLabel('Name',{exact:true}).fill('Unsaved editor acceptance');
  await cancel(false);assert.equal(await panel.getByLabel('Name',{exact:true}).inputValue(),'Unsaved editor acceptance');
  await cancel(true);await focused(panel.getByRole('heading',{name:'Saved funnels',exact:true}));
  await enter(panel.getByRole('button',{name:'New funnel',exact:true}));await focused(panel.getByRole('heading',{name:'New funnel',exact:true}));
  assert.equal(await panel.getByLabel('Name',{exact:true}).inputValue(),'');await panel.getByLabel('Name',{exact:true}).fill('Keyboard-only step controls');
  stage='keyboard step bounds and ordering';assert.equal(await panel.locator('.conversion-step').count(),2);
  for(const n of [1,2]){assert.equal(await panel.getByRole('button',{name:'Remove step '+n,exact:true}).isDisabled(),true);await step(n).getByLabel('Action',{exact:true}).selectOption('event');await step(n).getByLabel('Value',{exact:true}).fill(n===1?'A':'B');}
  await enter(panel.getByRole('button',{name:'Add step',exact:true}));await step(3).getByLabel('Action',{exact:true}).selectOption('event');await step(3).getByLabel('Value',{exact:true}).fill('C');
  await enter(panel.getByRole('button',{name:'Move step 3 up',exact:true}));assert.deepEqual(await panel.locator('.conversion-step input[id$="-value"]').evaluateAll(items=>items.map(el=>el.value)),['A','C','B']);
  await enter(panel.getByRole('button',{name:'Remove step 2',exact:true}));assert.deepEqual(await panel.locator('.conversion-step input[id$="-value"]').evaluateAll(items=>items.map(el=>el.value)),['A','B']);
  for(let n=2;n<8;n++)await enter(panel.getByRole('button',{name:'Add step',exact:true}));
  assert.equal(await panel.locator('.conversion-step').count(),8);assert.equal(await panel.getByRole('button',{name:'Add step',exact:true}).isDisabled(),true);
  assert.equal(await panel.getByRole('button',{name:'Move step 1 up',exact:true}).isDisabled(),true);assert.equal(await panel.getByRole('button',{name:'Move step 8 down',exact:true}).isDisabled(),true);
  for(let n=8;n>2;n--)await enter(panel.getByRole('button',{name:'Remove step '+n,exact:true}));
  assert.equal(await panel.locator('.conversion-step').count(),2);assert.equal(await panel.getByRole('button',{name:'Remove step 1',exact:true}).isDisabled(),true);
  console.log('PASS dirty cancel dismiss/accept, keyboard add/reorder/remove and minimum/maximum step bounds');

  stage='property transitions and preserved intermediate input';const first=step(1),summary=first.locator('summary').filter({hasText:'Property filters'});
  assert.equal(await summary.locator('..').getAttribute('open'),null);await enter(summary);await enter(first.getByRole('button',{name:'Add property filter',exact:true}));
  await first.getByLabel('Property key',{exact:true}).fill('plan');await first.getByLabel('JSON value',{exact:true}).fill('"unfinished');
  await first.getByLabel('Operator',{exact:true}).selectOption('missing');assert.equal(await first.getByLabel('Type',{exact:true}).count(),0);assert.equal(await first.getByLabel('JSON value',{exact:true}).count(),0);
  await first.getByLabel('Operator',{exact:true}).selectOption('eq');assert.equal(await first.getByLabel('JSON value',{exact:true}).inputValue(),'"unfinished');
  await first.getByLabel('Type',{exact:true}).selectOption('number');await first.getByLabel('JSON value',{exact:true}).fill('42');
  await first.getByLabel('Operator',{exact:true}).selectOption('contains');assert.equal(await first.getByLabel('Type',{exact:true}).inputValue(),'string');assert.equal(await first.getByLabel('Type',{exact:true}).isDisabled(),true);assert.equal(await first.getByLabel('JSON value',{exact:true}).inputValue(),'42');
  await first.getByLabel('Operator',{exact:true}).selectOption('eq');await first.getByLabel('Type',{exact:true}).selectOption('null');assert.equal(await first.getByLabel('JSON value',{exact:true}).count(),0);
  await first.getByLabel('Type',{exact:true}).selectOption('string');assert.equal(await first.getByLabel('JSON value',{exact:true}).inputValue(),'null');await first.getByLabel('JSON value',{exact:true}).fill('"pro"');
  await enter(first.getByRole('button',{name:'Add property filter',exact:true}));await enter(first.getByRole('button',{name:'Remove property filter 2',exact:true}));assert.equal(await first.getByLabel('Property key',{exact:true}).inputValue(),'plan');
  stage='editor responsive labels and screenshots';await mkdir(resolve(evidenceDir,'screenshots'),{recursive:true});
  for(const width of [1440,360]){
    await page.setViewportSize({width,height:width===360?860:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Editor must not create page-wide overflow.');
    const missing=await panel.locator('input,select,textarea').evaluateAll(items=>items.filter(el=>el.offsetParent!==null&&!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')).map(el=>el.tagName));assert.deepEqual(missing,[],'Visible native editor inputs need labels.');
    await first.getByLabel('JSON value',{exact:true}).focus();assert.equal(await first.getByLabel('JSON value',{exact:true}).inputValue(),'"pro"');
    await page.screenshot({path:resolve(evidenceDir,'screenshots','funnel-editor-'+width+'.png'),fullPage:true});
  }
  await cancel(true);await focused(panel.getByRole('heading',{name:'Saved funnels',exact:true}));
  assert.deepEqual(await saved(),before,'Editor-only acceptance must not change any saved definition.');assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  await writeFile(resolve(evidenceDir,'editor-acceptance.json'),JSON.stringify({status:'passed',completedAt:new Date().toISOString(),saved:false,viewports:[1440,360]},null,2)+'\n');
  console.log('PASS property transitions, preserved raw draft, labelled responsive editor and zero application writes');
}catch(error){
  const secrets=[fixture.owner.password,process.env.DATABASE_URL,process.env.AUTH_SECRET].filter(Boolean),redact=value=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value));
  await mkdir(evidenceDir,{recursive:true});await writeFile(resolve(evidenceDir,'editor-failure.txt'),redact(stage+'\n'+(error.stack??error))+'\n',{mode:0o600});await page.screenshot({path:resolve(evidenceDir,'editor-failure.png'),fullPage:true}).catch(()=>{});
  console.error('FAIL conversions editor: '+stage+' (private evidence saved).');process.exitCode=1;
}finally{await context.close();await browser.close();}
