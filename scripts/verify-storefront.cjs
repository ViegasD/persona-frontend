const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');

const catalogPlans = [{ id: 42, slug: 'teste', name: 'Teste do catalogo',
  price_cents: 2345, video_count: 2, max_characters_per_video: 3,
  features: ['Recurso do catalogo'] }];
const catalogCharacters = Array.from({ length: 201 }, (_, i) => ({
  id: `uuid-${i}`, slug: i === 200 ? 'bluey' : `catalog-char-${i}`,
  name: i === 200 ? 'Bluey do catalogo' : `Personagem ${i}`,
  thumbnail_url: 'https://images.test/bluey.webp', tags: ['Familia', 'aniversario'],
}));

async function verifyCatalogBoot(browser) {
  for (const failure of ['plans', 'later-page', 'empty-plans', 'empty-characters', 'invalid-plan', 'invalid-character']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    let retry = false;
    let accountLoads = 0;
    const offsets = [];
    let releaseLastPage;
    const lastPageGate = new Promise(resolve => { releaseLastPage = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('persona_access_token', 'test-token');
      if (!sessionStorage.getItem('persona_cart')) sessionStorage.setItem('persona_cart', JSON.stringify({ pkg: 'catalog-new', step: 3,
        basePrice: 1, maxVideos: 99, videos: [['removed-character'], ['bluey'], ['bluey']],
        childInfos: [{ name: 'Ana', occasion: 'aniversario' }], ts: Date.now() }));
    });
    await page.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname;
      if (endpoint.endsWith('/config')) return route.fulfill({ json: { account_email_enabled: true, video_processing_enabled: true } });
      if (endpoint.endsWith('/auth/google/config')) return route.fulfill({ json: { enabled: false } });
      if (url.hostname === 'images.test') {
        return route.fulfill({ contentType: 'image/webp', body: fs.readFileSync(path.resolve(__dirname, '..', 'img/bluey.webp')) });
      }
      if (!endpoint.includes('/api/v1/')) return route.abort();
      if (endpoint.endsWith('/auth/me')) {
        accountLoads++;
        return route.fulfill({ json: { id: 1, email: 'cliente@example.com', credit_balance: 3, email_verified: true } });
      }
      if (endpoint.endsWith('/catalog/plans')) {
        if (!retry && failure === 'plans') return route.fulfill({ status: 503, json: { detail: 'offline' } });
        const data = !retry && failure === 'empty-plans' ? []
          : !retry && failure === 'invalid-plan' ? [{ ...catalogPlans[0], price_cents: 'bad' }]
          : [{ ...catalogPlans[0], slug: 'catalog-new', price_cents: '2345',
            video_count: '2', max_characters_per_video: '3' },
            { ...catalogPlans[0], slug: 'aniversario', is_active: true },
            { ...catalogPlans[0], slug: 'inactive-plan', is_active: false }];
        return route.fulfill({ json: data });
      }
      if (endpoint.endsWith('/catalog/characters')) {
        assert.equal(url.searchParams.get('limit'), '200');
        const offset = Number(url.searchParams.get('offset'));
        offsets.push(offset);
        if (!retry && failure === 'later-page' && offset === 200) {
          return route.fulfill({ status: 503, json: { detail: 'offline' } });
        }
        if (retry && offset === 200) await lastPageGate;
        const data = !retry && failure === 'empty-characters' ? []
          : !retry && failure === 'invalid-character' ? [{ ...catalogCharacters[0], slug: null }]
          : catalogCharacters.slice(offset, offset + 200);
        return route.fulfill({ json: data });
      }
      throw new Error('Unexpected boot API: ' + endpoint);
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'checkout.html')).href);
    await page.locator('#catalogRetry').waitFor({ state: 'visible' });
    assert.match(await page.locator('#catalogMessage').innerText(), /indisponíveis/);
    assert.equal(await page.locator('.package-card').count(), 0);
    assert.equal(await page.locator('#btnS1').isDisabled(), true);
    assert.equal(await page.locator('#cartResumeBanner').count(), 0);
    assert.equal(accountLoads, 0);
    assert.deepEqual(await page.evaluate(() => [PACKAGES.length, CHARS.length, state.pkg]), [0, 0, null]);
    if (failure === 'plans') {
      await page.screenshot({ path: path.resolve('.cache/storefront-qa/catalog-error-mobile.png'), fullPage: true, animations: 'disabled' });
    }
    retry = true;
    offsets.length = 0;
    const lastPageRequest = page.waitForRequest(request => request.url().includes('offset=200'));
    await page.locator('#catalogRetry').click();
    await lastPageRequest;
    assert.equal(await page.locator('.package-card').count(), 0);
    assert.equal(await page.locator('#cartResumeBanner').count(), 0);
    releaseLastPage();
    await page.locator('#cartResumeBanner').waitFor();
    assert.deepEqual(offsets, [0, 200]);
    assert.equal(await page.locator('.package-card').count(), 1);
    await page.locator('#cartResumeBanner button').first().click();
    await page.waitForFunction(() => state.step === 3);
    assert.deepEqual(await page.evaluate(() => ({ price: state.basePrice, count: state.maxVideos,
      chars: state.maxChars, videos: state.videos })),
    { price: 2345, count: 2, chars: 3, videos: [[], ['bluey']] });
    assert.equal(await page.locator('.char-opt[data-id="bluey"] img').getAttribute('src'),
      'https://images.test/bluey.webp');
    assert.match(await page.locator('.char-opt[data-id="bluey"]').innerText(), /Familia, aniversario/);
    if (failure === 'plans') {
      const image = page.locator('.char-opt[data-id="bluey"] img');
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const img = document.querySelector('.char-opt[data-id="bluey"] img');
        return img.complete && img.naturalWidth > 0;
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.resolve('.cache/storefront-qa/catalog-characters-mobile.png'), animations: 'disabled' });
      for (const slug of ['inactive-plan', 'aniversario']) {
        await page.evaluate(slug => {
          sessionStorage.setItem('persona_cart', JSON.stringify({ pkg: slug, ts: Date.now() }));
        }, slug);
        await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'checkout.html')).href + '?plan=' + slug);
        await page.locator('#catalogStatus').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#cartResumeBanner').count(), 0);
        assert.equal(await page.evaluate(() => state.pkg), null);
        assert.equal(await page.locator('#btnS1').isDisabled(), true);
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const output = path.resolve('.cache/storefront-qa');
  fs.mkdirSync(output, { recursive: true });
  try {
    await verifyCatalogBoot(browser);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    const counts = { orders: 0, fill: 0, checkout: 0 };
    let waitingAuth;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('persona_access_token', 'test-token');
      window.pixelCalls = [];
      window.fbq = (...args) => window.pixelCalls.push(args);
    });
    // All remote requests are blocked or mocked, including payment and analytics.
    await page.route('https://**/*', async route => {
      const url = route.request().url();
      if (!url.includes('/api/v1/')) return route.abort();
      if (url.endsWith('/config')) return route.fulfill({ json: { account_email_enabled: true, video_processing_enabled: true } });
      if (url.endsWith('/auth/google/config')) return route.fulfill({ json: { enabled: false } });
      assert.equal(route.request().headers().authorization, 'Bearer test-token');
      let data;
      if (url.endsWith('/catalog/plans')) {
        data = catalogPlans;
      } else if (url.includes('/catalog/characters?')) {
        const query = new URL(url).searchParams;
        assert.equal(query.get('limit'), '200');
        const offset = Number(query.get('offset'));
        data = catalogCharacters.slice(offset, offset + 200);
      } else if (url.endsWith('/auth/google/config')) {
        return route.fulfill({ json: { enabled: false } });
      } else if (url.endsWith('/auth/me')) {
        data = { id: 1, email: 'cliente@example.com', credit_balance: 3, email_verified: true };
      } else if (url.endsWith('/orders/mine')) {
        data = [{ id: 10, status: 'PAID', items: [{ id: 20, character_ids: ['bluey'] }] }];
      } else if (url.endsWith('/orders')) {
        counts.orders++;
        data = { id: 10, total_cents: 1990 };
      } else if (url.endsWith('/fill')) {
        counts.fill++;
        data = { id: 10 };
      } else if (url.endsWith('/checkout')) {
        counts.checkout++;
        assert.deepEqual(route.request().postDataJSON(), { use_credits: true });
        if (counts.checkout === 1) {
          return route.fulfill({ status: 503, json: { detail: 'Tente novamente.' } });
        }
        data = { card_status: 'approved', payment_method: 'credits', amount_cents: 0 };
      } else if (url.endsWith('/orders/10')) {
        waitingAuth = route.request().headers().authorization;
        data = { id: 10, status: 'PAID', items: [], created_at: new Date().toISOString() };
      } else throw new Error('Unexpected API: ' + url);
      await route.fulfill({ json: data });
    });

    await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'checkout.html')).href + '?plan=teste');
    await page.waitForFunction(() => state.step === 2);
    assert.deepEqual(await page.evaluate(() => ({
      price: state.basePrice, videos: state.maxVideos, maxChars: PACKAGES[0].maxChars,
      chars: CHARS.length, lastChar: CHARS.at(-1),
    })), { price: 2345, videos: 2, maxChars: 3, chars: 201,
      lastChar: { id: 'bluey', name: 'Bluey do catalogo', img: 'https://images.test/bluey.webp',
        cat: 'Familia, aniversario' } });
    assert.match(await page.locator('#pkgGrid').innerText(), /Recurso do catalogo/);
    await page.evaluate(() => {
      state.videos = [['bluey']];
      state.childInfos = [{ name: 'Ana', occasion: 'aniversario' }];
      goStep(4);
      document.getElementById('stepForm').style.animation = 'none';
    });
    await page.locator('#accountStatus').filter({ hasText: 'Conectado' }).waitFor();
    await page.locator('#fBuyerName').fill('Cliente Teste');
    await page.locator('#fWa').fill('11999999999');
    await page.locator('#fEmail').fill('cliente@example.com');
    await page.locator('#tabCredits').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'checkout-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('.payment-flags img').evaluateAll(images =>
      images.every(image => image.complete && image.naturalWidth > 0)), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'checkout-desktop.png'), fullPage: true, animations: 'disabled' });

    await page.locator('#btnPay').click();
    await page.locator('#_toast').filter({ hasText: 'Tente novamente' }).waitFor();
    assert.deepEqual(counts, { orders: 1, fill: 1, checkout: 1 });
    // Capture analytics before navigation clears the page context.
    await page.evaluate(() => {
      window.addEventListener('pagehide', () => {
        sessionStorage.setItem('qa_pixels', JSON.stringify(window.pixelCalls));
      });
    });
    const waitingResponse = page.waitForResponse(response => response.url().endsWith('/orders/10'));
    await page.locator('#btnPay').click();
    await page.waitForURL('**/aguardando.html?oid=10');
    await waitingResponse;
    assert.deepEqual(counts, { orders: 1, fill: 1, checkout: 2 });
    assert.equal(waitingAuth, 'Bearer test-token');
    const pixels = await page.evaluate(() => JSON.parse(sessionStorage.getItem('qa_pixels') || '[]'));
    assert.equal(pixels.some(call => call[1] === 'Purchase'), false);

    await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'meus-videos.html')).href);
    await page.locator('#account-bar').waitFor({ state: 'visible' });
    assert.match(await page.locator('#account-summary').innerText(), /3 cr/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'account-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.locator('#logout').click();
    assert.equal(await page.locator('#login-form').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: catalog mapping, 201-character pagination, six boot failures/retries, delayed initialization, authoritative cart restoration, responsive layout, account library, credit payment retry, analytics and waiting authentication');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
