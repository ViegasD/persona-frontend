const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.argv[2] || 'playwright');

async function main() {
  const browser = await chromium.launch();
  try {
    for (const file of ['checkout.html', 'conta.html', 'meus-videos.html']) {
      const page = await browser.newPage();
      const googleRequests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'file:') return route.continue();
        if (url.hostname === 'accounts.google.com' || url.pathname.includes('/auth/google/')) {
          googleRequests.push(url.href);
          return route.fulfill({ json: { enabled: true } });
        }
        if (url.pathname.endsWith('/catalog/plans')) return route.fulfill({ json: [
          { id: 1, slug: 'test', name: 'Test', price_cents: 1990, video_count: 1, max_characters_per_video: 1, features: [] },
        ] });
        if (url.pathname.endsWith('/catalog/characters')) return route.fulfill({ json: [
          { id: 'bluey', slug: 'bluey', name: 'Bluey', thumbnail_url: 'https://assets.invalid/bluey.png', tags: [] },
        ] });
        return route.abort();
      });
      await page.goto(pathToFileURL(path.resolve(__dirname, '..', file)).href);
      if (file === 'checkout.html') await page.waitForFunction(() => catalogReady);
      await page.waitForTimeout(100);
      assert.deepEqual(googleRequests, [], file + ' must not load Google or request Google auth');
      assert.equal(await page.evaluate(() => typeof window.PersonaGoogle), 'undefined');
      assert.equal(await page.locator('.google-auth').isVisible(), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('PASS: Google sign-in paused on all three pages');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
