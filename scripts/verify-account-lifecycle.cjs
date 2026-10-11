const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');
const accountURL = pathToFileURL(path.resolve(__dirname, '..', 'conta.html')).href;
const libraryURL = pathToFileURL(path.resolve(__dirname, '..', 'meus-videos.html')).href;
const output = path.join(require('node:os').tmpdir(), 'persona-browser-qa', 'account-lifecycle');

async function main() {
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync(output, { recursive: true });
  let scenarios = 0;
  async function run(hash, token, test, overrides = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    if (token) await page.addInitScript(value => localStorage.setItem('persona_access_token', value), token);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.protocol === 'file:') return route.continue();
      if (!url.pathname.startsWith('/api/v1/')) return route.abort();
      const endpoint = url.pathname.slice('/api/v1'.length);
      if (endpoint === '/config') {
        return overrides[endpoint] ? overrides[endpoint](route, requests) : route.fulfill({ json: { account_email_enabled: true, video_processing_enabled: true } });
      }
      requests.push({ endpoint, method: request.method(), body: request.postDataJSON(), auth: request.headers().authorization });
      if (overrides[endpoint]) return overrides[endpoint](route, requests);
      const data = {
        '/auth/google/config': { enabled: false },
        '/auth/me': { id: 1, email: 'cliente.com.nome.longo@example.com', credit_balance: 2, credit_debt: 1, email_verified: false },
        '/credits/me': { balance: 2, debt: 1, transactions: [
          { id: 1, kind: 'signup_bonus', amount: 1, balance_after: 1, created_at: '2026-10-10T12:00:00Z' },
          { id: 2, kind: 'redeem', amount: -2, balance_after: 0, debt_after: 1, order_id: 123, created_at: '2026-10-11T12:00:00Z' },
        ] },
        '/auth/verify-email': { access_token: 'verified-token', user_id: 1 },
        '/auth/login': { access_token: 'login-token', user_id: 1 },
        '/auth/register': { access_token: 'signup-token', user_id: 1 },
        '/auth/reset-password': { message: 'Senha alterada.' },
        '/auth/forgot-password': { message: 'generic' },
        '/auth/resend-verification': { message: 'generic' },
        '/orders/mine': [],
      };
      assert.ok(endpoint in data, 'Unexpected API: ' + endpoint);
      if (['/auth/me', '/credits/me', '/auth/resend-verification', '/orders/mine'].includes(endpoint)) assert.ok(request.headers().authorization);
      return route.fulfill({ status: ['/auth/forgot-password', '/auth/resend-verification'].includes(endpoint) ? 202 : 200, json: data[endpoint] });
    });
    try {
      await page.goto((hash === 'library' ? libraryURL : accountURL) + (hash && hash !== 'library' ? '#' + hash : ''));
      await test(page, requests);
      assert.deepEqual(errors, []);
      scenarios++;
    } finally { await context.close(); }
  }
  async function screenshot(page, name) {
    for (const [size, width, height] of [['mobile', 390, 844], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' overflow');
      await page.screenshot({ path: path.join(output, name + '-' + size + '.png'), fullPage: true });
    }
  }
  try {
    await run('signup', null, async (page, requests) => {
      await page.locator('#auth-name').fill('Cliente');
      await page.locator('#auth-email').fill('cliente@example.com');
      await page.locator('#auth-password').fill('senha-segura');
      await page.locator('#auth-confirm').fill('outra-senha');
      await page.locator('#auth-button').click();
      await page.locator('#message').filter({ hasText: 'coincidem' }).waitFor();
      assert.equal(requests.length, 0);
      await page.locator('#auth-confirm').fill('senha-segura');
      await screenshot(page, 'signup');
      await page.locator('#auth-button').click();
      await page.locator('#account-details').waitFor();
      assert.deepEqual(requests.find(r => r.endpoint === '/auth/register').body, { name: 'Cliente', email: 'cliente@example.com', password: 'senha-segura' });
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'signup-token');
      await page.locator('#logout-button').click();
      await page.locator('#signed-out').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
    });
    await run('login', null, async page => {
      await page.locator('#auth-email').fill('cliente@example.com');
      await page.locator('#auth-password').fill('senha-segura');
      await screenshot(page, 'login');
      await page.locator('#auth-button').click();
      await page.locator('#account-details').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'login-token');
    });
    await run('signup', null, async (page, requests) => {
      await page.locator('#auth-availability').waitFor();
      assert.equal(await page.locator('#auth-button').isEnabled(), false);
      await page.locator('#login-tab').click();
      await page.locator('#auth-heading').filter({ hasText: 'Entrar' }).waitFor();
      assert.equal(await page.locator('#auth-button').isEnabled(), true);
      assert.equal(requests.length, 0);
    }, { '/config': route => route.fulfill({ json: { account_email_enabled: false, video_processing_enabled: false } }) });
    await run('', 'token', async page => {
      await page.locator('#processing-availability').waitFor();
      await page.locator('#mail-availability').waitFor();
      assert.equal(await page.locator('#resend-button').isEnabled(), false);
    }, { '/config': route => route.fulfill({ json: { account_email_enabled: false, video_processing_enabled: false } }) });
    await run('login', null, async page => {
      await page.locator('#auth-email').fill('cliente@example.com');
      await page.locator('#auth-password').fill('senha-segura');
      await page.locator('#auth-button').click();
      await page.locator('#message').filter({ hasText: 'incorretos' }).waitFor();
      assert.equal(await page.locator('#auth-button').isEnabled(), true);
    }, { '/auth/login': route => route.fulfill({ status: 401, json: { detail: 'invalid credentials' } }) });
    await run('library', null, async page => {
      assert.equal(await page.locator('#login-form a[href="conta.html#forgot"]').count(), 1);
    });
    await run('', null, async (page, requests) => {
      await page.locator('#signed-out').waitFor();
      assert.equal(requests.filter(request => request.endpoint !== '/auth/google/config').length, 0);
    });
    await run('', 'existing-token', async (page, requests) => {
      await page.locator('#account-details').waitFor();
      assert.match(await page.locator('#verification-status').innerText(), /pendente/);
      assert.match(await page.locator('#balance').innerText(), /2 cr/);
      assert.match(await page.locator('#debt').innerText(), /1 cr/);
      assert.match(await page.locator('#history').innerText(), /Boas-vindas/);
      assert.match(await page.locator('#history').innerText(), /-2 cr/);
      await page.locator('#resend-button').click();
      await page.locator('#message').filter({ hasText: 'enviado' }).waitFor();
      assert.equal(requests.find(r => r.endpoint === '/auth/resend-verification').auth, 'Bearer existing-token');
      await screenshot(page, 'account');
      await page.locator('#account-details a[href="conta.html#forgot"]').click();
      await page.locator('#forgot-section').waitFor({ timeout: 2000 });
      assert.equal(new URL(page.url()).hash, '');
    });
    await run('verify=single%2Buse', null, async (page, requests) => {
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(requests.length, 0);
      await page.locator('#verify-button').click();
      await page.locator('#account-details').waitFor();
      assert.match(await page.locator('#verification-status').innerText(), /E-mail verificado/);
      assert.equal(await page.locator('#resend-button').isVisible(), false);
      assert.deepEqual(requests.find(r => r.endpoint === '/auth/verify-email').body, { token: 'single+use' });
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'verified-token');
      assert.equal(requests.filter(r => r.endpoint === '/auth/verify-email').length, 1);
    }, { '/auth/me': route => route.fulfill({ json: { id: 1, email: 'cliente@example.com', email_verified: true, credit_balance: 1 } }) });
    await run('verify=expired', null, async (page, requests) => {
      await page.locator('#verify-button').click();
      await page.locator('#message').filter({ hasText: 'expirado' }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
      assert.equal(requests.length, 1);
      await screenshot(page, 'verify-error');
    }, { '/auth/verify-email': route => route.fulfill({ status: 400, json: { detail: 'Link expirado. Solicite outro.' } }) });
    await run('reset=reset-secret', 'old-token', async (page, requests) => {
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(requests.length, 0);
      await page.locator('#new-password').fill('1234567');
      await page.locator('#confirm-password').fill('1234567');
      await page.locator('#reset-button').click();
      await page.locator('#message').filter({ hasText: '8 a 128' }).waitFor();
      await page.locator('#new-password').fill('a'.repeat(129));
      await page.locator('#confirm-password').fill('a'.repeat(129));
      await page.locator('#reset-button').click();
      assert.equal(requests.length, 0);
      await page.locator('#new-password').fill('nova-senha');
      await page.locator('#confirm-password').fill('diferente');
      await page.locator('#reset-button').click();
      await page.locator('#message').filter({ hasText: 'coincidem' }).waitFor();
      assert.equal(requests.length, 0);
      await page.locator('#confirm-password').fill('nova-senha');
      await screenshot(page, 'reset');
      await page.locator('#reset-button').click();
      await page.locator('#reset-success').waitFor();
      assert.deepEqual(requests[0].body, { token: 'reset-secret', password: 'nova-senha' });
      assert.equal(requests[0].auth, undefined);
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
      assert.equal(await page.locator('#new-password').inputValue(), '');
      assert.equal(await page.locator('#reset-success a').getAttribute('href'), 'meus-videos.html');
    });
    await run('reset=expired', 'old-token', async page => {
      await page.locator('#new-password').fill('nova-senha');
      await page.locator('#confirm-password').fill('nova-senha');
      await page.locator('#reset-button').click();
      await page.locator('#message').filter({ hasText: 'expirado' }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), 'old-token');
    }, { '/auth/reset-password': route => route.fulfill({ status: 400, json: { detail: 'Link expirado.' } }) });
    await run('forgot', null, async (page, requests) => {
      assert.equal(new URL(page.url()).hash, '');
      await page.locator('#recovery-email').fill('cliente@example.com');
      await page.locator('#forgot-button').click();
      await page.locator('#message').filter({ hasText: 'Se houver uma conta' }).waitFor();
      assert.deepEqual(requests[0].body, { email: 'cliente@example.com' });
      await screenshot(page, 'forgot');
    });
    await run('', 'old-token', async page => {
      await page.locator('#signed-out').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('persona_access_token')), null);
    }, { '/auth/me': route => route.fulfill({ status: 401, json: { detail: 'expired' } }) });
    await run('', 'token', async page => {
      await page.locator('#account-details').waitFor();
      await page.locator('#resend-button').click();
      await page.locator('#message').filter({ hasText: 'Tente mais tarde' }).waitFor();
      assert.equal(await page.locator('#resend-button').isEnabled(), true);
    }, { '/auth/resend-verification': route => route.fulfill({ status: 429, json: { detail: 'Tente mais tarde.' } }) });
    await run('library', 'token', async page => {
      await page.locator('#account-bar').waitFor();
      assert.match(await page.locator('#account-summary').innerText(), /pendente/);
      assert.equal(await page.locator('#account-verification-link').isVisible(), true);
      await screenshot(page, 'library');
    });
    await run('forgot', null, async page => {
      await page.locator('#recovery-email').fill('cliente@example.com');
      await page.locator('#forgot-button').click();
      await page.locator('#message').filter({ hasText: 'conectar' }).waitFor();
      assert.equal(await page.locator('#forgot-button').isEnabled(), true);
    }, { '/auth/forgot-password': route => route.abort() });
    await run('', 'token', async page => {
      await page.locator('#ledger-retry').waitFor();
      await page.locator('#ledger-retry').click();
      await page.locator('#ledger-message').filter({ hasText: 'Nenhuma movimentação' }).waitFor();
      assert.equal(await page.locator('#debt-row').isVisible(), false);
      assert.equal(await page.locator('#resend-button').isVisible(), false);
    }, {
      '/auth/me': route => route.fulfill({ json: { id: 1, email: 'cliente@example.com', email_verified: true, credit_balance: 0 } }),
      '/credits/me': (route, requests) => requests.filter(r => r.endpoint === '/credits/me').length === 1
        ? route.fulfill({ status: 503, json: { detail: 'Histórico indisponível.' } })
        : route.fulfill({ json: { balance: 0, transactions: [] } }),
    });
    await run('verify=', null, async (page, requests) => {
      await page.locator('#verify-button').click();
      await page.locator('#message').filter({ hasText: 'Link inválido' }).waitFor();
      assert.equal(requests.length, 0);
    });
    await run('', 'token', async page => {
      await page.locator('#account-retry').waitFor();
      await page.locator('#account-retry').click();
      await page.locator('#account-details').waitFor();
    }, { '/auth/me': (route, requests) => requests.filter(r => r.endpoint === '/auth/me').length === 1
      ? route.fulfill({ status: 503, json: { detail: 'Conta indisponível.' } })
      : route.fulfill({ json: { id: 1, email: 'cliente@example.com', email_verified: true, credit_balance: 0 } }) });
    await run('reset=long-password', null, async (page, requests) => {
      await page.locator('#new-password').fill('a'.repeat(128));
      await page.locator('#confirm-password').fill('a'.repeat(128));
      await page.locator('#reset-button').click();
      await page.locator('#reset-success').waitFor();
      assert.equal(requests[0].body.password.length, 128);
    });
    console.log(`PASS: ${scenarios} account lifecycle scenarios; mocked network; desktop/mobile screenshots in ${output}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
