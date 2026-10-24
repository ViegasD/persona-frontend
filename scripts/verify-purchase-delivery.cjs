const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.argv[2] || 'playwright');
const video = fs.readFileSync(process.argv[3]);
const root = path.resolve(__dirname, '..');
const output = path.resolve('.cache/purchase-delivery-qa');
fs.mkdirSync(output, {recursive:true});

(async () => {
 const browser = await chromium.launch({headless:true});
 try {
  for (const width of [390,1440]) {
   const page = await browser.newPage({viewport:{width,height:900},acceptDownloads:true});
   const errors=[];
   let stage='AWAITING_PAYMENT';
   let orderCreates=0, payments=0;
   const order=()=>({id:10,status:stage==='LINKS_PENDING'?'GENERATING':stage,total_cents:7689,
    recipient_name:'Cliente Teste',created_at:new Date().toISOString(),items:[0,1,2].map(n=>({
     id:201+n,sequence:n+1,character_ids:[['bluey','skye'],['bluey'],['bingo']][n],
     status:stage==='FAILED'?'FAILED':['LINKS_PENDING','DELIVERED'].includes(stage)?'READY':'PENDING',
     custom_message:JSON.stringify({_child:{name:['Ana','Bia','Caio'][n]}})+'\nMensagem',
     video_url:stage==='DELIVERED'?`https://media.test/video-${201+n}.mp4`:null,
    }))});
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>localStorage.setItem('persona_access_token','qa-account'));
   await page.route('https://**/*',async route=>{
    const request=route.request();const url=new URL(request.url());
    if(url.hostname==='media.test'){
     if(url.pathname.endsWith('.webp'))return route.fulfill({contentType:'image/webp',body:fs.readFileSync(path.join(root,'img/bluey.webp'))});
     return route.fulfill({contentType:'video/mp4',headers:{'Content-Disposition':'attachment; filename="test-video.mp4"'},body:video});
    }
    if(!url.pathname.includes('/api/v1/'))return route.abort();
    const endpoint=url.pathname.split('/api/v1')[1];
    if(endpoint.endsWith('/thumbnail'))return route.fulfill({contentType:'image/webp',body:fs.readFileSync(path.join(root,'img/bluey.webp'))});
    let data;
    if(endpoint==='/config')data={video_processing_enabled:true,account_email_enabled:true};
    else if(endpoint==='/auth/me')data={id:1,email:'qa@example.com',email_verified:true,credit_balance:0};
    else if(endpoint==='/catalog/plans')data=[{id:2,slug:'surpresa',name:'Plano Surpresa',price_cents:6990,video_count:3,max_characters_per_video:2,features:[]}];
    else if(endpoint.startsWith('/catalog/characters'))data=['bluey','skye','bingo'].map((slug,id)=>({id,slug,name:slug,thumbnail_url:'https://media.test/bluey.webp',tags:[]}));
    else if(endpoint==='/orders'&&request.method()==='POST'){orderCreates++;assert.equal(request.postDataJSON().plan_id,'surpresa');data=order();}
    else if(endpoint==='/orders/10/fill'){
     const body=request.postDataJSON();
     assert.deepEqual(body.video_slots,[['bluey','skye'],['bluey'],['bingo']]);
     assert.deepEqual(body.recipient_names,['Ana','Bia','Caio']);
     assert.equal(body.quality,'sd');data=order();
    } else if(endpoint==='/orders/10/checkout'){
     payments++;data={order_id:10,payment_id:99,payment_method:'pix',qr_code_payload:'test-pix-copy',
      qr_code_base64:fs.readFileSync(path.join(root,'img/Recado-animado-LOGO.png')).toString('base64'),amount_cents:7689};
    } else if(endpoint==='/orders/10')data=order();
    else if(endpoint==='/orders/mine')data=[order()];
    else throw Error('Unexpected request: '+endpoint);
    return route.fulfill({json:data});
   });
   await page.goto(pathToFileURL(path.join(root,'checkout.html')).href);
   await page.locator('.package-card').click();await page.locator('#btnS1').click();await page.locator('#btnS2').click();
   await page.locator('.char-opt[data-id=bluey]').click();await page.locator('.char-opt[data-id=skye]').click();
   assert.equal(await page.locator('.char-opt[data-id=bingo]').isDisabled(),true);
   await page.locator('[data-video-slot="1"]').click();await page.locator('.char-opt[data-id=bluey]').click();
   await page.locator('[data-video-slot="2"]').click();await page.locator('.char-opt[data-id=bingo]').click();
   for(const [i,name] of ['Ana','Bia','Caio'].entries()){
    await page.locator('#csName'+i).fill(name);await page.locator('#csOcc'+i).selectOption('aniversario');await page.locator('#csAge'+i).fill('6');
   }
   await page.locator('#csBtnNext').click();
   await page.locator('#fBuyerName').fill('Cliente Teste');await page.locator('#fWa').fill('11999999999');await page.locator('#fEmail').fill('qa@example.com');
   assert.match(await page.locator('#sumTotal').innerText(),/76,89/);
   assert.equal(await page.locator('#sumExtraRow').isVisible(),true);
   await page.screenshot({path:path.join(output,`checkout-${width}.png`),fullPage:true,animations:'disabled'});
   await page.locator('#btnPay').click();await page.locator('#pixScreen').waitFor({state:'visible'});
   assert.equal(await page.locator('#pixCopy').inputValue(),'test-pix-copy');
   assert.equal(orderCreates,1);assert.equal(payments,1);
   stage='GENERATING';await page.evaluate(()=>pollOrder(10));await page.waitForURL('**/aguardando.html?oid=10');
   await page.locator('#card-201').waitFor();
   assert.doesNotMatch(await page.locator('#wanote').innerText(),/WhatsApp/);
   stage='LINKS_PENDING';await page.evaluate(()=>tick());
   assert.equal(await page.evaluate(()=>isDone),false);
   assert.equal(await page.locator('.item-video').count(),0);
   stage='DELIVERED';await page.evaluate(()=>tick());
   assert.equal(await page.locator('.item-video').count(),3);
   assert.match(await page.locator('#heroTitle').innerText(),/prontos/);
   await page.locator('.btn-fs').first().click();
   await page.waitForFunction(()=>document.querySelector('#vPlayer').videoWidth===160);
   await page.waitForFunction(()=>document.querySelector('#vPlayer').currentTime>0.1);
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('#vOverlay').evaluate(el=>el.open),false);
   const downloaded=page.waitForEvent('download');await page.locator('.btn-dl').first().click();
   assert.equal((await downloaded).suggestedFilename(),'test-video.mp4');
   assert.match(await page.locator('#card-201').innerText(),/Para: Ana/);
   await page.screenshot({path:path.join(output,`delivered-${width}.png`),fullPage:true,animations:'disabled'});
   await page.goto(pathToFileURL(path.join(root,'meus-videos.html')).href);
   await page.locator('.order-card').first().waitFor();assert.equal(await page.locator('.order-card').count(),3);
   await page.locator('a[title=Assistir]').first().click();await page.waitForFunction(()=>document.querySelector('#video-player').videoWidth===160);
   await page.keyboard.press('Escape');assert.equal(await page.locator('#video-overlay').evaluate(el=>el.open),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   stage='FAILED';await page.goto(pathToFileURL(path.join(root,'aguardando.html')).href+'?oid=10');
   await page.locator('#heroSub').filter({hasText:'Não foi possível concluir'}).waitFor();
   assert.equal(await page.locator('.item-video').count(),0);
   stage='REFUNDED';await page.goto(pathToFileURL(path.join(root,'aguardando.html')).href+'?oid=10');
   await page.locator('#errTitle').filter({hasText:'reembolsado'}).waitFor();
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: desktop/mobile purchase through Pix confirmation, multi-character limits/pricing, per-video data, generation, delayed media availability, playback, download, account library, failure and refund states; all providers mocked');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
