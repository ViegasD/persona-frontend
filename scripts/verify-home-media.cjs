const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const{chromium}=require(process.argv[2]||'playwright');
const base=process.argv[3]||'http://127.0.0.1:19483/';
const output=path.resolve('.cache/home-media-qa');fs.mkdirSync(output,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true});try{
 for(const width of[390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  const errors=[];const videos=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().includes('.mp4'))videos.push(request.url());});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const deferred=page.locator('video:not(#heroVideo)');
  assert.equal(await deferred.evaluateAll(items=>items.every(v=>v.preload==='none'&&!!v.poster)),true);
  assert.equal(videos.some(url=>/reaction-|demo\.v1/.test(url)),false);
  const hero=page.locator('#heroVideo');
  await hero.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('#heroVideo').currentTime>0.2);
  assert.equal(await hero.evaluate(v=>v.videoWidth>0&&v.videoHeight>0),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,`hero-${width}.png`),animations:'disabled'});
  const report=page.locator('.report-card').first();await report.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('#heroVideo').paused);
  assert.equal(await hero.evaluate(v=>v.paused),true);
  await report.locator('.report-play').click();
  await page.waitForFunction(()=>document.querySelector('.report-card video').currentTime>0.2);
  await report.locator('video').evaluate(v=>v.currentTime=Math.min(v.duration/2,5));
  await page.waitForFunction(()=>document.querySelector('.report-card video').readyState>=2);
  await report.locator('.report-play').click();
  assert.equal(await report.locator('video').evaluate(v=>v.paused),true);
  await page.screenshot({path:path.join(output,`reports-${width}.png`),animations:'disabled'});
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('PASS: mobile/desktop optimized hero playback, posters, no eager offscreen video, pause offscreen, reaction play/pause and seek, responsive layout');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
