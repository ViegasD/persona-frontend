const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(os.tmpdir(), 'persona-browser-qa', 'account-navigation');

async function main() {
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const width of [360, 390, 1024, 1210, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'file:') return route.continue();
        if (url.pathname.includes('/catalog/')) return route.fulfill({ json: [] });
        return route.abort();
      });
      await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
      if (width <= 1200) {
        await page.locator('.menu-toggle').click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.mobile-nav')).opacity === '1');
      }
      const nav = page.locator(width <= 1200 ? '.mobile-nav' : '.nav');
      assert.equal(await nav.locator('[data-account-link]').innerText(), 'Entrar');
      assert.equal(await nav.locator('[data-signup-link]').isVisible(), true);
      await page.evaluate(() => window.PersonaSession.setToken('mock-token'));
      assert.equal(await nav.locator('[data-account-link]').innerText(), 'Minha conta e créditos');
      assert.equal(await nav.locator('[data-account-link]').getAttribute('href'), 'conta.html');
      assert.equal(await nav.locator('[data-signup-link]').isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const links = await nav.locator('a:visible').evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }));
      for (let i = 0; i < links.length; i++) {
        assert.ok(links[i].left >= 0 && links[i].right <= width, 'Link outside viewport');
        for (let j = i + 1; j < links.length; j++) {
          const a = links[i], b = links[j];
          assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'Navigation links overlap');
        }
      }
      await page.screenshot({ path: path.join(output, `navigation-${width}.png`), animations: 'disabled' });
      await page.evaluate(() => window.PersonaSession.clear());
      assert.equal(await nav.locator('[data-signup-link]').isVisible(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const mutations = [];
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.protocol === 'file:') return route.continue();
      if (request.method() !== 'GET') mutations.push(url.pathname);
      if (url.pathname.endsWith('/config')) return route.fulfill({ json: { account_email_enabled: false, video_processing_enabled: false } });
      if (url.pathname.endsWith('/catalog/plans')) return route.fulfill({ json: [{ id: 1, slug: 'teste', name: 'Teste', price_cents: 2990, video_count: 1, max_characters_per_video: 1, features: [] }] });
      if (url.pathname.includes('/catalog/characters')) return route.fulfill({ json: [{ id: 'bluey', slug: 'bluey', name: 'Bluey', thumbnail_url: 'img/bluey.webp', tags: [] }] });
      return route.abort();
    });
    await page.goto(pathToFileURL(path.join(root, 'checkout.html')).href);
    await page.locator('#checkoutAvailability').waitFor();
    await page.evaluate(() => submitCheckout());
    assert.deepEqual(mutations, []);
    assert.equal(await page.locator('#btnAccountRegister').isEnabled(), false);
    assert.equal(await page.locator('#btnAccountLogin').isEnabled(), true);
    await page.screenshot({ path: path.join(output, 'checkout-paused.png') });
    await context.close();
    console.log('PASS: account navigation at five viewport widths, session changes, and paused checkout without mutations');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
