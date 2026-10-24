const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');

const url = pathToFileURL(path.resolve(__dirname, '..', 'meus-videos.html')).href;
const output = path.resolve('.cache/account-library-qa');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ['populated', 'empty', 'retry', 'expired', 'guest', 'switch', 'logout-pending']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      let mineCalls = 0;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(scenario => {
        if (scenario !== 'guest') localStorage.setItem('persona_access_token', 'account-a');
        sessionStorage.setItem('persona_guest_token', 'unrelated-guest-order');
      }, scenario);
      await page.route('https://**/*', async route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (!endpoint.includes('/api/v1/')) return route.abort();
        assert.equal(route.request().headers()['x-guest-token'], undefined);
        const b = route.request().headers().authorization === 'Bearer account-b';
        if (endpoint.endsWith('/auth/me')) {
          if (scenario === 'expired') return route.fulfill({status:401,json:{detail:'expired'}});
          return route.fulfill({json:{id:b?2:1,email:b?'bob@example.com':'alice@example.com',credit_balance:0,email_verified:true}});
        }
        if (endpoint.endsWith('/orders/mine')) {
          mineCalls++;
          if (scenario === 'retry' && mineCalls === 1) return route.fulfill({status:503,json:{detail:'unavailable'}});
          if (['switch','logout-pending'].includes(scenario) && !b) await gate;
          return route.fulfill({json:scenario === 'empty' ? [] : [{id:b?202:101,status:'DELIVERED',items:[{
            id:b?22:11,character_ids:[b?'bluey':'skye'],video_url:'https://media.test/video.mp4',status:'READY',
          }]}]});
        }
        throw Error('Unexpected library request: '+endpoint);
      });
      await page.goto(url);
      assert.equal(await page.locator('#phone-input, #btn-search').count(), 0);
      if (scenario === 'guest' || scenario === 'expired') {
        await page.locator('#login-form').waitFor({state:'visible'});
        if (scenario === 'expired') await page.locator('#error-msg.show').waitFor();
        assert.equal(mineCalls,0);
        assert.equal(await page.locator('.order-card').count(),0);
      } else {
        await page.locator('#account-bar').waitFor({state:'visible'});
        if (scenario === 'retry') {
          await page.locator('#library-retry').click();
        } else if (scenario === 'switch' || scenario === 'logout-pending') {
          await page.waitForFunction(() => document.querySelector('#library-loading').hidden === false);
          if (scenario === 'switch') {
            await page.evaluate(() => {
              localStorage.setItem('persona_access_token','account-b');
              window.dispatchEvent(new StorageEvent('storage',{key:'persona_access_token',newValue:'account-b'}));
            });
            await page.locator('.order-meta').filter({hasText:'#202'}).waitFor();
          } else await page.locator('#logout').click();
          release();
        }
        if (scenario === 'logout-pending') {
          await page.locator('#login-form').waitFor({state:'visible'});
          assert.equal(await page.locator('.order-card').count(),0);
        } else {
          await page.locator('#results.show').waitFor();
          const text = await page.locator('#results-list').innerText();
          if (scenario === 'empty') assert.match(text,/ainda não tem vídeos/);
          else assert.match(text,scenario === 'switch'?/#202/:/#101/);
          if (scenario === 'switch') assert.doesNotMatch(text,/#101/);
          for (const width of [390,1440]) {
            await page.setViewportSize({width,height:900});
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
            if (['empty','populated'].includes(scenario)) await page.screenshot({path:path.join(output,`${scenario}-${width}.png`),fullPage:true});
          }
          await page.locator('#logout').click();
          assert.equal(await page.locator('.order-card').count(),0);
        }
      }
      assert.deepEqual(errors,[]);
      await context.close();
    }
    console.log('PASS: account-only automatic library, no guest lookup/header, populated/empty states, retry, expired session, account switch, logout race, mobile/desktop layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
