(() => {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const apiBaseUrl = window.PERSONA_CONFIG?.apiBaseUrl || (local
    ? 'http://localhost:8001/api/v1'
    : 'https://hermes-persona-website.5tpiot.easypanel.host/api/v1');
  window.PersonaConfig = Object.freeze({ apiBaseUrl: apiBaseUrl.replace(/\/+$/, '') });
  window.PersonaOrder = Object.freeze({
    recipientName(item, order) {
      let name = item.child_name;
      if (!name && typeof item.custom_message === 'string') {
        try { name = JSON.parse(item.custom_message.split('\n', 1)[0])?._child?.name; }
        catch { /* Older orders do not have per-video metadata. */ }
      }
      return typeof name === 'string' && name.trim() ? name : (order.recipient_name || '');
    },
  });

  let revision = 0;
  const getToken = () => localStorage.getItem('persona_access_token');
  function changed() {
    revision++;
    window.dispatchEvent(new Event('persona-session-change'));
  }
  window.PersonaSession = {
    getToken,
    snapshot: () => ({ token: getToken(), revision }),
    isCurrent: snapshot => snapshot.token === getToken() && snapshot.revision === revision,
    setToken(token) { localStorage.setItem('persona_access_token', token); changed(); },
    clear() { localStorage.removeItem('persona_access_token'); changed(); },
  };
  window.addEventListener('storage', event => {
    if (event.key === 'persona_access_token' || event.key === null) changed();
  });
})();
