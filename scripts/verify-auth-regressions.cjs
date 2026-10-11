const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');

const sdk = `window.google = { accounts: { id: {
  initialize: config => { window.googleConfig = config; },
  renderButton: root => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = 'Mock Google';
    button.onclick = () => window.googleConfig.callback({credential:'credential'});
    root.append(button);
  }
} } };`;
const user = { id: 1, email: 'person@gmail.com', credit_balance: 3, email_verified: true, google_linked: false };

async function main() {
  fs.mkdirSync('.cache/storefront-qa', { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  let passed = 0;
  async function scenario(name, file, initialToken, handler, check, apiOverride) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const calls = [], errors = [];
    let challenges = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ token, api }) => {
      if (token) localStorage.setItem('persona_access_token', token);
      if (api) window.PERSONA_CONFIG = { apiBaseUrl: api };
    }, { token: initialToken, api: apiOverride });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'file:') {
        if (url.pathname.endsWith('.html')) {
          const html = fs.readFileSync(fileURLToPath(url), 'utf8');
          return route.fulfill({ contentType: 'text/html', body: html.replace(/<!-- Google sign-in paused[^\n]*\r?\n(<script src="google-auth\.js" defer><\/script>)\r?\n-->/g, '$1') });
        }
        return route.continue();
      }
      if (url.hostname === 'accounts.google.com') return route.fulfill({ contentType: 'application/javascript', body: sdk });
      if (!url.pathname.startsWith('/api/v1/')) return route.abort();
      const endpoint = url.pathname.slice('/api/v1'.length);
      const call = { endpoint, auth: route.request().headers().authorization, body: route.request().postDataJSON(), host: url.hostname };
      calls.push(call);
      if (await handler?.(route, call, calls)) return;
      if (endpoint === '/auth/google/challenge') return route.fulfill({ json: { client_id: 'test', nonce: 'nonce-' + (++challenges) } });
      const data = {
        '/auth/google/config': { enabled: true },
        '/auth/google/login': { access_token: 'google-session' },
        '/auth/google/link': { access_token: 'google-session' },
        '/auth/login': { access_token: 'password-session' },
        '/auth/me': user, '/orders/mine': [], '/credits/me': { balance: 3, debt: 0, transactions: [] },
        '/catalog/plans': [{ id: 1, slug: 'test', name: 'Test', price_cents: 1990, video_count: 1, max_characters_per_video: 1, features: [] }],
        '/catalog/characters': [{ id: 'bluey', slug: 'bluey', name: 'Bluey', thumbnail_url: 'https://assets.invalid/bluey.png', tags: [] }],
        '/orders': { id: 10, total_cents: 1990 }, '/orders/10/fill': { id: 10 },
        '/orders/10/checkout': { card_status: 'approved', payment_method: 'credits', amount_cents: 0 },
      };
      if (!(endpoint in data)) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ json: data[endpoint] });
    });
    try {
      await page.goto(pathToFileURL(path.resolve(__dirname, '..', file.split('?')[0])).href + (file.includes('?') ? '?' + file.split('?')[1] : ''));
      await check(page, calls);
      assert.deepEqual(errors, [], 'browser errors');
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'horizontal overflow');
      }
      passed++;
      console.log('PASS: ' + name);
    } catch (error) {
      failures.push(name + ': ' + error.message);
      console.error('FAIL: ' + failures.at(-1));
    } finally { await context.close(); }
  }
  try {
    let releaseGoogle;
    const googleGate = new Promise(resolve => { releaseGoogle = resolve; });
    await scenario('stale Google response cannot replace password session', 'meus-videos.html', null, async (route, call) => {
      if (call.endpoint !== '/auth/google/login') return false;
      await googleGate;
      await route.fulfill({ json: { access_token: 'stale-google' } });
      return true;
    }, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForFunction(() => document.querySelector('.google-auth [role=status]').textContent.includes('Conectando'));
      await page.locator('#account-email').fill('person@gmail.com');
      await page.locator('#account-password').fill('password123');
      await page.locator('#login-button').click();
      await page.locator('#account-bar').waitFor();
      releaseGoogle();
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'password-session');
      assert.equal(calls.filter(c => c.endpoint === '/auth/google/login').length, 1);
    });

    await scenario('logout renews single-use Google nonce', 'meus-videos.html', null, null, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.locator('#account-bar').waitFor();
      await page.locator('#logout').click();
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.locator('#account-bar').waitFor();
      const logins = calls.filter(c => c.endpoint === '/auth/google/login');
      assert.equal(logins.length, 2);
      assert.notEqual(logins[0].body.nonce, logins[1].body.nonce);
    });

    await scenario('failed password login leaves Google usable', 'meus-videos.html', null, async (route, call) => {
      if (call.endpoint !== '/auth/login') return false;
      await route.fulfill({ status: 401, json: {} }); return true;
    }, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).waitFor();
      await page.locator('#account-email').fill('person@gmail.com');
      await page.locator('#account-password').fill('wrong-password');
      await page.locator('#login-button').click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(calls.some(c => c.endpoint === '/auth/google/login'), true);
    });

    await scenario('suspended page does not send expired Google nonce', 'meus-videos.html', null, null, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).waitFor();
      await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 11 * 60 * 1000; });
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(calls.some(c => c.endpoint === '/auth/google/login'), false);
      assert.equal(calls.filter(c => c.endpoint === '/auth/google/challenge').length, 2);
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.locator('#account-bar').waitFor();
    });

    await scenario('expired account resets Google to login', 'conta.html', 'expired', async (route, call) => {
      if (call.endpoint !== '/auth/me' || call.auth !== 'Bearer expired') return false;
      await route.fulfill({ status: 401, json: { detail: 'expired' } }); return true;
    }, async (page, calls) => {
      await page.locator('#signed-out').waitFor();
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(calls.some(c => c.endpoint === '/auth/google/login'), true);
      assert.equal(calls.some(c => c.endpoint === '/auth/google/link'), false);
    });

    let releaseOldAccount;
    const oldAccountGate = new Promise(resolve => { releaseOldAccount = resolve; });
    await scenario('old account 401 cannot clear a newer Google session', 'conta.html', 'old-session', async (route, call) => {
      if (call.endpoint !== '/auth/me' || call.auth !== 'Bearer old-session') return false;
      await oldAccountGate;
      await route.fulfill({ status: 401, json: { detail: 'expired' } }); return true;
    }, async page => {
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.locator('#account-details').waitFor();
      releaseOldAccount();
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'google-session');
      assert.equal(await page.locator('#account-details').isVisible(), true);
    });

    let configRequests = 0;
    await scenario('initial config failure exposes retry', 'meus-videos.html', null, async (route, call) => {
      if (call.endpoint !== '/auth/google/config' || ++configRequests !== 1) return false;
      await route.fulfill({ status: 503, json: { detail: 'temporarily offline' } }); return true;
    }, async page => {
      await page.waitForTimeout(150);
      assert.equal(await page.getByRole('button', { name: 'Tentar Google novamente' }).isVisible(), true);
      assert.ok((await page.getByRole('button', { name: 'Tentar Google novamente' }).boundingBox()).height >= 40, 'retry must have a usable touch target');
      await page.screenshot({ path: '.cache/storefront-qa/google-config-retry-mobile.png', fullPage: true });
      await page.getByRole('button', { name: 'Tentar Google novamente' }).click();
      await page.getByRole('button', { name: 'Mock Google' }).waitFor();
    });

    let libraryRequests = 0;
    await scenario('library failure preserves account and exposes retry', 'meus-videos.html', null, async (route, call) => {
      if (call.endpoint !== '/orders/mine' || ++libraryRequests !== 1) return false;
      await route.fulfill({ status: 503, json: {} }); return true;
    }, async page => {
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#account-bar').isVisible(), true);
      assert.equal(await page.locator('#login-form').isVisible(), false);
      await page.screenshot({ path: '.cache/storefront-qa/library-retry-mobile.png', fullPage: true });
      await page.locator('#library-retry').click();
      await page.locator('#results').waitFor();
    });

    await scenario('library 401 clears saved session', 'meus-videos.html', null, async (route, call) => {
      if (call.endpoint !== '/orders/mine') return false;
      await route.fulfill({ status: 401, json: {} }); return true;
    }, async page => {
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
      assert.equal(await page.locator('#login-form').isVisible(), true);
    });

    await scenario('guest token recovers after expired bearer', 'aguardando.html?oid=10#t=valid-guest', 'expired', async (route, call) => {
      if (call.endpoint !== '/orders/10') return false;
      assert.equal(route.request().headers()['x-guest-token'], 'valid-guest');
      await route.fulfill({ status: call.auth ? 401 : 200, json: call.auth ? {} : { id: 10, status: 'PAID', items: [] } }); return true;
    }, async (page, calls) => {
      await page.waitForTimeout(250);
      assert.equal(calls.filter(c => c.endpoint === '/orders/10' && !c.auth).length, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
    });

    await scenario('overlapping guest recoveries do not reject after token removal', 'aguardando.html?oid=10#t=valid-guest', null, async (route, call) => {
      if (call.endpoint !== '/orders/10') return false;
      if (call.auth) await new Promise(resolve => setTimeout(resolve, 50));
      await route.fulfill({ status: call.auth ? 401 : 200, json: call.auth ? {} : { id: 10, status: 'PAID', items: [] } }); return true;
    }, async page => {
      await page.waitForTimeout(100);
      const statuses = await page.evaluate(async () => {
        localStorage.setItem('persona_access_token', 'expired');
        return (await Promise.allSettled([apiFetch('/orders/10'), apiFetch('/orders/10')])).map(result => result.status);
      });
      assert.deepEqual(statuses, ['fulfilled', 'fulfilled']);
    });

    await scenario('cross-tab session change keeps Google recoverable', 'meus-videos.html', null, null, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).waitFor();
      await page.evaluate(() => {
        localStorage.setItem('persona_access_token', 'other-tab');
        window.dispatchEvent(new StorageEvent('storage', { key: 'persona_access_token', newValue: 'other-tab' }));
        localStorage.removeItem('persona_access_token');
        window.dispatchEvent(new StorageEvent('storage', { key: 'persona_access_token', newValue: null }));
      });
      const retry = page.getByRole('button', { name: 'Tentar Google novamente' });
      if (await retry.isVisible()) await retry.click();
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.waitForTimeout(150);
      assert.equal(calls.some(c => c.endpoint === '/auth/google/login'), true);
    });

    await scenario('checkout rejects an identity changed before submission', 'checkout.html', 'account-A', async (route, call) => {
      if (call.endpoint !== '/auth/me' || call.auth !== 'Bearer account-B') return false;
      await route.fulfill({ json: { ...user, id: 2, email: 'other@gmail.com' } }); return true;
    }, async (page, calls) => {
      await page.waitForFunction(() => catalogReady && state.account);
      await page.evaluate(async () => {
        state.pkg = 1; state.maxVideos = 1; state.videos = [['bluey']]; state.childInfos = [{ name: 'Ana', age: '5', occasion: 'aniversario' }];
        state.payMethod = 'credits'; goStep(4);
        document.getElementById('fBuyerName').value = 'Person'; document.getElementById('fEmail').value = 'person@gmail.com';
        document.getElementById('fWa').value = '11999999999'; document.getElementById('btnPay').disabled = false;
        localStorage.setItem('persona_access_token', 'account-B');
        await submitCheckout();
      });
      assert.equal(calls.filter(c => c.endpoint === '/orders').length, 0);
      assert.equal(await page.evaluate(() => state.account?.id), 2);
    });

    let releaseOrder;
    const orderGate = new Promise(resolve => { releaseOrder = resolve; });
    await scenario('checkout locks identity and rejects cross-tab changes', 'checkout.html', 'account-A', async (route, call) => {
      if (call.endpoint === '/auth/me' && call.auth === 'Bearer account-B') {
        await route.fulfill({ json: { ...user, id: 2, email: 'other@gmail.com' } }); return true;
      }
      if (call.endpoint !== '/orders') return false;
      await orderGate;
      await route.fulfill({ json: { id: 10, total_cents: 1990 } }); return true;
    }, async (page, calls) => {
      await page.waitForFunction(() => catalogReady && state.account);
      await page.evaluate(() => {
        state.pkg = 1; state.maxVideos = 1; state.videos = [['bluey']]; state.childInfos = [{ name: 'Ana', age: '5', occasion: 'aniversario' }];
        state.payMethod = 'credits'; goStep(4);
        document.getElementById('fBuyerName').value = 'Person'; document.getElementById('fEmail').value = 'person@gmail.com';
        document.getElementById('fWa').value = '11999999999'; document.getElementById('btnPay').disabled = false;
        window.paymentTask = submitCheckout();
      });
      await page.waitForFunction(() => state.checkoutBusy);
      const locked = await page.locator('#btnAccountLogout').isDisabled();
      await page.evaluate(() => localStorage.setItem('persona_access_token', 'account-B'));
      releaseOrder();
      await page.evaluate(() => window.paymentTask);
      assert.equal(locked, true);
      assert.equal(calls.filter(c => c.endpoint.endsWith('/fill') || c.endpoint.endsWith('/checkout')).length, 0);
      assert.equal(await page.evaluate(() => state.account?.id), 2, 'checkout must reload the changed account');
    });

    await scenario('shared frontend API configuration is honored', 'meus-videos.html', null, null, async (page, calls) => {
      await page.getByRole('button', { name: 'Mock Google' }).waitFor();
      await page.getByRole('button', { name: 'Mock Google' }).click();
      await page.locator('#account-bar').waitFor();
      assert.equal(calls.every(c => c.host === 'staging.example.test'), true);
    }, 'https://staging.example.test/api/v1');
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
