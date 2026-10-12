const fs=require('fs'),assert=require('assert');
const {chromium}=require('playwright');
const path=require('path');
const root=path.resolve(__dirname,'..'),now=Date.now(),GB=1024**3;
const artifactDir=path.join(root,'.artifacts');fs.mkdirSync(artifactDir,{recursive:true});
const names=['Demo Alpha','Demo Beta','Demo Gamma','Demo Delta'];
const regions=['美国 US','台湾 TW','新加坡 SG','英国 GB','阿联酋 AE','澳大利亚 AU','日本 JP','未识别专线'];
const subs=names.map((name,i)=>({id:'demo'+i,name,url:'https://example.invalid/sub',source:i===2?'file':'url',mode:'pull',state:'active',online:true,total:1000*GB,used:(200+i*50)*GB,remaining:(800-i*50)*GB,upload:10*GB,download:(190+i*50)*GB,expire:now+86400000*40,quotaUpdatedAt:now,lastCheck:now,resourceUpdatedAt:now,resourceFormat:'Clash YAML',nodeCount:8,nodesMore:0,usageToday:{bytes:2*GB,since:now-3600000,until:now,partial:true,reset:false},nodes:regions.map((r,j)=>({name:r+' '+(j+1),protocol:j%2?'trojan':'vmess',transport:'tcp',security:'tls',testable:true,online:true,latencyMs:70+j*20,probeState:'ok'}))}));
(async()=>{
 const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),headless:true,args:['--no-sandbox']});
 const errors=[],results=[];
 for(const width of [320,360,375,390,430,768,1366,1920]){
  const page=await browser.newPage({viewport:{width,height:width<500?844:900},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(width+': '+e.message));
  await page.addInitScript(()=>{localStorage.setItem('sm_token','test-fixture-token');localStorage.setItem('monitor-overview-collapsed','1');});
  await page.route('**/page.html',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/.artifacts/page.html','utf8')}));
  await page.route('**/api/**',r=>r.fulfill({json:{subs}}));
  await page.goto('http://monitor.test/page.html');
  await page.locator('#overview>.metric').nth(3).waitFor();
  assert.equal(await page.locator('#items>.card').count(),4);
  const geometry=await page.evaluate(()=>{
   const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
   return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,header:document.querySelector('.app-header').getBoundingClientRect().bottom,overview:rect('overview'),dock:document.querySelector('.bottom-dock').getBoundingClientRect().toJSON(),countries:[...document.querySelectorAll('#subscriptionRegions .country-en')].map(x=>({text:x.textContent,whiteSpace:getComputedStyle(x).whiteSpace,height:x.getBoundingClientRect().height})),duplicates:[...document.querySelectorAll('[id]')].map(x=>x.id).filter((v,i,a)=>a.indexOf(v)!==i)};
  });
  assert(geometry.scrollWidth<=width,JSON.stringify(geometry));
  assert(geometry.overview.top>=geometry.header, 'Overview covered by header '+width);
  assert(geometry.dock.left>=0&&geometry.dock.right<=width,'Dock outside viewport');
  assert.equal(geometry.duplicates.length,0,'Duplicate IDs');
  assert(geometry.countries.every(x=>x.whiteSpace==='nowrap'),'Country English wraps');
  if(width===390||width===1366||width===1920)await page.screenshot({path:artifactDir+'/preview-'+width+'.png',fullPage:width>760,animations:'disabled'});
  assert.equal(await page.locator('#logout,#viewHeading,#displayTools,#interfaceSettings').count(),0);
  assert.deepEqual(await page.locator('.reference-controls button').evaluateAll(bs=>bs.map(b=>b.id)),['themeLight','themeSystem','theme','displayMode','headerToolsToggle']);
  const firstCardTop=await page.locator('#items>.card').first().evaluate(e=>e.getBoundingClientRect().top);
  if(width===390)assert(firstCardTop<844*.55,'Overview still takes most of screen');
  if(width>760){
   const desktop=await page.evaluate(()=>({overview:document.getElementById('overview').getBoundingClientRect().width,shell:document.querySelector('.shell').getBoundingClientRect().width,sort:document.getElementById('sortName').getBoundingClientRect().width,label:document.querySelector('#sortName span').getBoundingClientRect().height,labelLine:parseFloat(getComputedStyle(document.querySelector('#sortName span')).lineHeight),notes:[...document.querySelectorAll('#overview>.metric>span')].map(e=>getComputedStyle(e).whiteSpace)}));
   assert(Math.abs(desktop.overview-desktop.shell)<1,'Desktop overview leaves blank strip');
   assert(desktop.sort>=86,'Sort button squeezed');
   assert(desktop.label<=desktop.labelLine+1,'Sort text wraps');
   assert(desktop.notes.every(v=>v==='normal'),'Desktop summary notes clipped');
  }
  const position=await page.evaluate(()=>({
   header:document.querySelector('.app-header').getBoundingClientRect().bottom,
   actions:document.querySelector('.subscriptions-toolbar').getBoundingClientRect().toJSON(),
   overview:document.getElementById('overview').getBoundingClientRect().toJSON(),
   regions:document.getElementById('subscriptionRegions').getBoundingClientRect().toJSON()
  }));
  assert(position.actions.top>=position.header,'Actions overlap header');
  assert(position.actions.bottom<=position.overview.top,'Actions are below overview');
  assert(position.actions.bottom<position.regions.top,'Actions are below countries');
  await page.locator('#headerToolsToggle').click();
  await page.waitForFunction(()=>document.getElementById('headerTools').getBoundingClientRect().width<1);
  assert.equal(await page.locator('#headerToolsToggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#headerTools').evaluate(e=>e.inert),true);
  if(width===390)await page.screenshot({path:artifactDir+'/preview-collapsed.png',animations:'disabled'});
  await page.reload();await page.locator('#overview>.metric').nth(3).waitFor();
  assert.equal(await page.locator('#headerToolsToggle').getAttribute('aria-expanded'),'false');
  await page.locator('#headerToolsToggle').click();
  await page.waitForFunction(()=>{const e=document.getElementById('headerTools');return e.getBoundingClientRect().width>=e.scrollWidth-.5;});
  assert.equal(await page.locator('#headerToolsToggle').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#headerTools').evaluate(e=>e.inert),false);
  const singleLine=await page.evaluate(()=>{
   const brand=document.querySelector('.app-brand').getBoundingClientRect(),tools=document.querySelector('.reference-controls').getBoundingClientRect(),title=document.querySelector('.app-header h1');
   return {brandCenter:brand.top+brand.height/2,toolsCenter:tools.top+tools.height/2,titleWidth:title.clientWidth,titleScroll:title.scrollWidth,actionHeight:document.querySelector('.subscriptions-toolbar').getBoundingClientRect().height};
  });
  assert(Math.abs(singleLine.brandCenter-singleLine.toolsCenter)<1,'Header wraps at '+width);
  assert(singleLine.titleScroll<=singleLine.titleWidth+1,'Title clipped at '+width);
  assert(singleLine.actionHeight<=(width<=760?35:39),'Action row too tall');
  const topButtons=await page.locator('.reference-controls button').evaluateAll(bs=>bs.map(b=>b.getBoundingClientRect().toJSON()));
  topButtons.forEach((r,i)=>{assert(r.x>=0&&r.right<=width);if(i)assert(r.x>=topButtons[i-1].right,'Header buttons overlap');});
  assert(await page.locator('#overview').isVisible());
  const regionHeight=await page.locator('#subscriptionRegions').evaluate(e=>e.getBoundingClientRect().height);
  if(width<500)assert(regionHeight<175,'Country area too tall: '+regionHeight);
  await page.locator('#theme').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  if(width===390||width===1366)await page.screenshot({path:artifactDir+'/preview-dark-'+width+'.png',animations:'disabled'});
  await page.locator('#themeSystem').click();
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.locator('#themeLight').click();
  const modes=['compact','tiles','table','detail'];
  for(const mode of modes){
   await page.locator('#displayMode').click();
   assert.equal(await page.locator('html').getAttribute('data-display'),mode);
   assert.equal(await page.locator('#items').getAttribute('data-display'),mode);
   assert.equal(await page.locator('#displayMode').getAttribute('data-mode'),mode);
   assert.equal(await page.locator('#items>.card').count(),mode==='table'?0:4);
   if(mode==='table')assert.equal(await page.locator('#items tbody tr').count(),4);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mode causes page overflow '+width+' '+mode);
   if(width===390||width===1366||width===1920)await page.screenshot({path:artifactDir+'/mode-'+width+'-'+mode+'.png',animations:'disabled'});
  }
  await page.locator('#displayMode').press('ArrowLeft');
  assert.equal(await page.locator('html').getAttribute('data-display'),'table');
  await page.locator('#displayMode').press('ArrowRight');
  assert.equal(await page.locator('html').getAttribute('data-display'),'detail');
  await page.locator('[data-view=nodes]').click();
  assert(await page.locator('#view-nodes').isVisible());
  await page.locator('#displayMode').click();
  assert(await page.locator('#view-nodes').isVisible());
  assert.equal(await page.locator('#regionList .country-en').count(),8);
  await page.locator('[data-view=control]').click();
  assert(await page.locator('#view-control').isVisible());
  await page.locator('#displayMode').click();
  assert(await page.locator('#view-control').isVisible());
  await page.locator('[data-view=subs]').click();
  assert(await page.locator('#view-subs').isVisible());
  assert.equal(await page.locator('#items').getAttribute('data-display'),'tiles');
  await page.locator('#displayMode').click();await page.locator('#displayMode').click();
  await page.reload();
  await page.locator('#overview>.metric').nth(3).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-display'),'detail');
  await page.locator('#screenOpen').click();
  assert(await page.locator('#screenDlg').isVisible());
  await page.locator('#screenClose').click();
  await page.locator('#add').click();
  assert(await page.locator('#addDlg').isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  const ending=await page.evaluate(()=>({fine:document.querySelector('.fine').getBoundingClientRect().bottom,dock:document.querySelector('.bottom-dock').getBoundingClientRect().top}));
  assert(ending.fine<=ending.dock,'Bottom content hidden '+width+JSON.stringify(ending));
  results.push({width,firstCardTop,checks:'inline fold/unfold, fold persistence, actions above overview/countries, 4 layouts, system theme, tabs, dialogs, no overlap'});
  await page.close();
 }
 assert.deepEqual(errors,[],'Client runtime errors');
 fs.writeFileSync(artifactDir+'/ui-checks.json',JSON.stringify({results,errors},null,2));
 await browser.close();console.log('Passed responsive and interaction checks across 8 viewport widths.');
})().catch(e=>{console.error(e);process.exit(1)});
