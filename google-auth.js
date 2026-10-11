(() => {
  const API = window.PersonaConfig.apiBaseUrl;
  const root = document.querySelector('.google-auth');
  if (!root) return;
  let sdkPromise, busy = false, generation = 0, refreshTimer, renewAt = 0;
  const buttonHost = document.createElement('div');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:.8rem;line-height:1.5;margin-top:8px;overflow-wrap:anywhere';
  const retry = document.createElement('button');
  retry.type = 'button'; retry.textContent = 'Tentar Google novamente'; retry.hidden = true;
  retry.style.cssText = 'width:100%;min-width:0;min-height:44px;margin-top:8px;padding:10px 14px;border:1px solid var(--border,#aaa);border-radius:8px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;overflow-wrap:anywhere';
  root.style.cssText = 'margin-top:14px;min-width:0;grid-column:1/-1';
  root.append(buttonHost, status, retry);

  async function request(path, body, linking = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (linking) {
      const token = localStorage.getItem('persona_access_token');
      if (!token) throw new Error('Entre na conta antes de vincular o Google.');
      headers.Authorization = 'Bearer ' + token;
    }
    const response = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Google indisponível. Tente novamente.');
    return data;
  }

  function loadSDK() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => { script.remove(); reject(new Error('Google não carregou. Tente novamente.')); }, 15000);
      script.src = 'https://accounts.google.com/gsi/client?hl=pt-BR'; script.async = true;
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Google não carregou. Tente novamente.')); };
      document.head.append(script);
    }).catch(error => { sdkPromise = null; throw error; });
    return sdkPromise;
  }

  function invalidate() {
    generation++;
    clearTimeout(refreshTimer);
    busy = false;
    buttonHost.style.pointerEvents = '';
  }

  function active(attempt) {
    return attempt === generation && root.dataset.googleDisabled !== 'true';
  }

  async function credentialReceived(result, attempt, nonce, session) {
    if (!active(attempt) || !window.PersonaSession.isCurrent(session) || busy || !root.getClientRects().length) return;
    if (Date.now() >= renewAt) { await start(); return; }
    busy = true; buttonHost.style.pointerEvents = 'none'; status.textContent = 'Conectando…'; retry.hidden = true;
    try {
      const linking = root.dataset.googleMode === 'link';
      const token = await request('/auth/google/' + (linking ? 'link' : 'login'), { credential: result.credential, nonce }, linking);
      if (!active(attempt) || !window.PersonaSession.isCurrent(session)) return;
      if (!token.access_token) throw new Error('Não foi possível concluir o login Google.');
      window.PersonaSession.setToken(token.access_token);
      retry.hidden = true;
      status.textContent = linking ? 'Google vinculado' : 'Conta conectada';
      window.dispatchEvent(new CustomEvent('persona-google-auth', { detail: { linking } }));
    } catch (error) {
      if (!active(attempt) || !window.PersonaSession.isCurrent(session)) return;
      status.textContent = error.message;
      retry.hidden = false;
      buttonHost.replaceChildren();
    } finally {
      if (attempt === generation) { busy = false; buttonHost.style.pointerEvents = ''; }
    }
  }

  async function start() {
    invalidate();
    const attempt = generation;
    const session = window.PersonaSession.snapshot();
    const current = () => active(attempt) && window.PersonaSession.isCurrent(session);
    buttonHost.replaceChildren();
    if (!active(attempt)) { root.hidden = true; return; }
    retry.hidden = true;
    try {
      const config = await request('/auth/google/config');
      if (!current()) return;
      if (!config.enabled) { root.hidden = true; return; }
      root.hidden = false; status.textContent = 'Carregando Google…';
      const section = document.getElementById('google-section');
      if (section) section.hidden = false;
      await loadSDK();
      if (!current()) return;
      const challenge = await request('/auth/google/challenge', {});
      if (!current()) return;
      renewAt = Date.now() + 9 * 60 * 1000;
      google.accounts.id.initialize({ client_id: challenge.client_id, nonce: challenge.nonce,
        callback: result => credentialReceived(result, attempt, challenge.nonce, session), auto_select: false, ux_mode: 'popup' });
      buttonHost.replaceChildren();
      google.accounts.id.renderButton(buttonHost, { theme: 'outline', size: 'large', text: 'continue_with',
        shape: 'rectangular', locale: 'pt-BR', width: Math.max(200, Math.min(400, root.clientWidth || 300)) });
      status.textContent = '';
      // Renew before the server's ten-minute expiration, including idle pages.
      refreshTimer = setTimeout(start, 9 * 60 * 1000);
    } catch (error) {
      if (!current()) return;
      root.hidden = false; status.textContent = error.message; retry.hidden = false;
      const section = document.getElementById('google-section');
      if (section) section.hidden = false;
    }
  }
  retry.addEventListener('click', start);
  window.PersonaGoogle = { refresh: start, invalidate };
  window.addEventListener('persona-session-change', () => {
    invalidate();
    buttonHost.replaceChildren();
    if (!root.hidden && root.dataset.googleDisabled !== 'true') {
      status.textContent = 'Sua sess\u00e3o mudou. Tente novamente.';
      retry.hidden = false;
    }
  });
  window.addEventListener('focus', () => {
    if (renewAt && Date.now() >= renewAt && !busy && root.getClientRects().length && active(generation)) start();
  });
  new MutationObserver(() => {
    if (root.dataset.googleDisabled === 'true') { invalidate(); root.hidden = true; }
  }).observe(root, { attributes: true, attributeFilter: ['data-google-disabled', 'data-google-mode'] });
  start();
})();
