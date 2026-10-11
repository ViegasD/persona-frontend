# Persona Frontend

Customer pages for the FastAPI service in `ViegasD/persona-website`.
The legacy `ViegasD/persona` bot is not used for this application.

Set the deployed API URL in `storefront-config.js`. The Dockerfile serves
this directory with nginx. No build step is required.

Google sign-in remains commented out on checkout, account and video-library
pages pending verification. Email accounts and credits use the API; registration
and password recovery require SMTP configured on its API and worker.

## Browser Tests

Install Playwright and Chromium in your test environment, then run from this
repository root (the module path argument is optional when installed locally):

```sh
node scripts/verify-container.cjs
node scripts/verify-google-paused.cjs /path/to/playwright
node scripts/verify-account-lifecycle.cjs /path/to/playwright
node scripts/verify-storefront.cjs /path/to/playwright
node scripts/verify-google-auth.cjs /path/to/playwright
node scripts/verify-auth-regressions.cjs /path/to/playwright
```

All remote requests are mocked or blocked. The last two suites enable Google
only in intercepted test HTML; deployed files remain commented out. Screenshots
are written to `.cache/storefront-qa`, excluded from Git.
