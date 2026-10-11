const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');

async function main() {
  const browser = await chromium.launch();
  const output = path.resolve('.cache/storefront-qa');
  fs.mkdirSync(output, { recursive: true });
  let count = 0;
  try {
    for (const [file, signedIn, enabled, failure] of [
      ['meus-videos.html', false, true, false],
      ['conta.html', false, true, false],
      ['conta.html', true, true, false],
      ['meus-videos.html', false, true, true],
      ['meus-videos.html', false, false, false],
      ['meus-videos.html', false, true, 'sdk-error'],
      ['checkout.html', false, true, false],
    ]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [], calls = [];
      let sdkLoads = 0;
      page.on('pageerror', error => errors.push(error.message));
      if (signedIn) await page.addInitScript(() => localStorage.setItem('persona_access_token', 'existing-session'));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'file:') {
          if (url.pathname.endsWith('.html')) {
            const html = fs.readFileSync(fileURLToPath(url), 'utf8');
            return route.fulfill({ contentType: 'text/html', body: html.replace(/<!-- Google sign-in paused[^\n]*\r?\n(<script src="google-auth\.js" defer><\/script>)\r?\n-->/g, '$1') });
          }
          return route.continue();
        }
        if (url.hostname === 'accounts.google.com' && url.pathname === '/gsi/client') {
          if (failure === 'sdk-error' && ++sdkLoads === 1) return route.abort();
          return route.fulfill({ contentType: 'application/javascript', body: `
            window.google = { accounts: { id: {
              initialize: config => { window.googleConfig = config; },
              renderButton: root => {
                const button = document.createElement('button'); button.type = 'button';
                button.textContent = 'Continuar com Google';
                button.style.cssText = 'background:white;color:#333;border:1px solid #ccc;width:100%;height:44px;margin:0';
                button.onclick = () => window.googleConfig.callback({credential:'mock-google-credential'});
                root.append(button);
              }
            } } };` });
        }
        if (!url.pathname.startsWith('/api/v1/')) return route.abort();
        const endpoint = url.pathname.slice('/api/v1'.length);
        const request = route.request();
        calls.push({ endpoint, body: request.postDataJSON(), auth: request.headers().authorization });
        if (endpoint === '/auth/google/config') return route.fulfill({ json: { enabled } });
        if (endpoint === '/auth/google/challenge') return route.fulfill({ json: { client_id: 'test.apps.googleusercontent.com', nonce: 'test-challenge-nonce-123456' } });
        if (['/auth/google/login', '/auth/google/link'].includes(endpoint)) {
          assert.equal(request.postDataJSON().nonce, 'test-challenge-nonce-123456');
          assert.equal(request.postDataJSON().credential, 'mock-google-credential');
          if (endpoint.endsWith('/link')) assert.equal(request.headers().authorization, 'Bearer existing-session');
          else assert.equal(request.headers().authorization, undefined);
          return route.fulfill({ status: failure === true ? 409 : 200, json: failure === true ? { detail: 'Entre com sua senha e vincule o Google em Minha conta.' } : { access_token: 'google-session', user_id: 1 } });
        }
        const data = {
          '/auth/me': { id: 1, email: 'cliente@gmail.com', credit_balance: 1, email_verified: true, google_linked: calls.some(call => call.endpoint === '/auth/google/link') },
          '/orders/mine': [], '/credits/me': { balance: 1, debt: 0, transactions: [] },
          '/catalog/plans': [{ id: 1, slug: 'test', name: 'Teste', price_cents: 1990, video_count: 1, max_characters_per_video: 1, features: [] }],
          '/catalog/characters': [{ id: '1', slug: 'bluey', name: 'Bluey', thumbnail_url: 'https://assets.invalid/bluey.png', tags: [] }],
        };
        assert.ok(endpoint in data, 'Unexpected API: ' + endpoint);
        return route.fulfill({ json: data[endpoint] });
      });
      await page.goto(pathToFileURL(path.resolve(__dirname, '..', file)).href);
      if (file === 'checkout.html') {
        await page.waitForFunction(() => catalogReady);
        await page.evaluate(() => goStep(4));
      }
      if (!enabled) {
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.google-auth').isVisible(), false);
        assert.equal(calls.filter(call => call.endpoint === '/auth/google/challenge').length, 0);
      } else {
        if (failure === 'sdk-error') {
          await page.getByText('Google não carregou. Tente novamente.').waitFor();
          await page.getByRole('button', { name: 'Tentar Google novamente' }).click();
        }
        const button = page.getByRole('button', { name: 'Continuar com Google' });
        await button.waitFor();
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.screenshot({ path: path.join(output, `google-button-${file}-${signedIn}-${width}.png`), fullPage: true });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => window.googleConfig.nonce), 'test-challenge-nonce-123456');
        await button.click();
        if (failure === true) {
          await page.getByText('Entre com sua senha e vincule o Google em Minha conta.').waitFor();
          assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
        } else {
          await page.waitForFunction(() => localStorage.getItem('persona_access_token') === 'google-session');
          if (signedIn) await page.locator('#google-linked').waitFor();
        }
      }
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, `google-${file}-${signedIn}-${enabled}-${failure}.png`), fullPage: true });
      await context.close();
      count++;
    }
  } finally { await browser.close(); }
  console.log(`PASS: ${count} Google signup/login/link/disabled/conflict browser scenarios`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
