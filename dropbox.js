// Integración mínima con Dropbox usando OAuth PKCE, subida y restauración de backups
const DropboxSync = (function(){
  const STORAGE_KEY = 'diario_dropbox_tokens_v1';
  const APP_KEY_KEY = 'diario_dropbox_app_key';
  const STATE_KEY = 'diario_dropbox_oauth_state';
  const VERIFIER_KEY = 'diario_dropbox_pkce_verifier';
  const LAST_SYNC_KEY = 'diario_dropbox_last_sync';
  const PLAIN_PENDING_KEY = 'diario_dropbox_pending_plain';

  let tokens = null;
  let lastSync = null;
  let lastAuthResult = null;
  let encryptedTokensRaw = null;
  let pendingPlainTokens = null;
  const listeners = new Set();

  function notify(){
    const state = getStatus();
    listeners.forEach((fn) => {
      try { fn(state); } catch (err) { console.error('Dropbox listener error', err); }
    });
  }

  function isCryptoUnlocked() {
    return typeof Crypto === 'object' && typeof Crypto.isUnlocked === 'function' && Crypto.isUnlocked();
  }

  function rememberEncryptedTokens(raw) {
    encryptedTokensRaw = raw;
    if (raw) {
      localStorage.setItem(STORAGE_KEY, raw);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  async function ensureTokensDecrypted() {
    if (tokens) return tokens;
    if (!encryptedTokensRaw) return null;
    if (!isCryptoUnlocked()) return null;
    try {
      const decrypted = await Crypto.decryptString(encryptedTokensRaw);
      tokens = JSON.parse(decrypted);
      return tokens;
    } catch (err) {
      if (err && /No hay sesión desbloqueada/i.test(String(err.message || err))) {
        return null;
      }
      console.warn('No se pudieron descifrar los tokens de Dropbox', err);
      return null;
    }
  }

  async function loadStoredTokens() {
    pendingPlainTokens = null;
    const pendingRaw = sessionStorage.getItem(PLAIN_PENDING_KEY);
    if (pendingRaw) {
      try {
        pendingPlainTokens = JSON.parse(pendingRaw);
      } catch (err) {
        console.warn('No se pudo recuperar los tokens pendientes de Dropbox', err);
        sessionStorage.removeItem(PLAIN_PENDING_KEY);
        pendingPlainTokens = null;
      }
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      tokens = null;
      encryptedTokensRaw = null;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accessToken && parsed.refreshToken) {
        // Formato antiguo sin cifrar. Lo migraremos cuando el diario esté desbloqueado.
        pendingPlainTokens = parsed;
        tokens = null;
        encryptedTokensRaw = null;
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (parsed && parsed.iv && parsed.ct) {
        encryptedTokensRaw = raw;
        tokens = null;
        if (isCryptoUnlocked()) {
          await ensureTokensDecrypted();
        }
        return;
      }
    } catch (err) {
      // No era JSON parseable; asumimos que ya es la cadena cifrada.
      encryptedTokensRaw = raw;
      tokens = null;
      if (isCryptoUnlocked()) {
        await ensureTokensDecrypted();
      }
      return;
    }
    // Si llegamos aquí, el contenido no es reconocido. Mejor limpiarlo.
    console.warn('Formato de tokens de Dropbox no reconocido. Se eliminarán.');
    localStorage.removeItem(STORAGE_KEY);
    tokens = null;
    encryptedTokensRaw = null;
  }

  async function saveTokens(next){
    if (!next) {
      tokens = null;
      pendingPlainTokens = null;
      rememberEncryptedTokens(null);
      sessionStorage.removeItem(PLAIN_PENDING_KEY);
      notify();
      return 'cleared';
    }
    if (!isCryptoUnlocked()) {
      pendingPlainTokens = next;
      tokens = null;
      rememberEncryptedTokens(null);
      try {
        sessionStorage.setItem(PLAIN_PENDING_KEY, JSON.stringify(next));
      } catch (err) {
        console.warn('No se pudo guardar tokens pendientes de Dropbox', err);
      }
      notify();
      return 'pending';
    }
    const payload = { ...next };
    const encrypted = await Crypto.encryptString(JSON.stringify(payload));
    tokens = payload;
    pendingPlainTokens = null;
    rememberEncryptedTokens(encrypted);
    sessionStorage.removeItem(PLAIN_PENDING_KEY);
    notify();
    return 'saved';
  }

  function saveLastSync(ts){
    lastSync = ts;
    if (ts) {
      localStorage.setItem(LAST_SYNC_KEY, String(ts));
    } else {
      localStorage.removeItem(LAST_SYNC_KEY);
    }
    notify();
  }

  function randomString(len){
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, (byte) => ('0' + (byte & 0xff).toString(16)).slice(-2)).join('');
  }

  function bufferToBase64Url(buffer){
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+/g, '');
  }

  async function generatePkce(){
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = bufferToBase64Url(verifierBytes.buffer)
      .replace(/[^a-zA-Z0-9._~-]/g, '')
      .slice(0, 128);
    const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = bufferToBase64Url(challengeBuffer);
    return { verifier, challenge };
  }

  function getRedirectUri(){
    return window.location.origin + window.location.pathname;
  }

  async function exchangeCode(code){
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const state = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    if (!verifier || !state) throw new Error('Sesión OAuth inválida');

    const appKey = getAppKey();
    if (!appKey) throw new Error('Falta el App Key de Dropbox');

    const redirectUri = getRedirectUri();
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Canje de código fallido: ${errText}`);
    }
    const data = await response.json();
    const next = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accountId: data.account_id,
      expiresAt: Date.now() + ((data.expires_in || 3600) - 30) * 1000,
      scope: data.scope
    };
    const saveResult = await saveTokens(next);
    if (saveResult === 'saved') {
      await hydrateAccountInfo();
      lastAuthResult = { status: 'linked' };
    } else {
      lastAuthResult = { status: 'pending_unlock' };
    }
    notify();
  }

  async function hydrateAccountInfo(){
    await ensureTokensDecrypted();
    if (!tokens || !tokens.accessToken) return;
    try {
      const response = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: 'null'
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn('Dropbox get_current_account falló', response.status, errText);
        if (response.status === 401 || response.status === 400) {
          await handleAuthFailure(errText);
        }
        return;
      }
      const info = await response.json();
      tokens.accountName = info.name?.display_name || null;
      tokens.email = info.email || null;
      await saveTokens({ ...tokens });
    } catch (err) {
      console.warn('No se pudo obtener la cuenta de Dropbox', err);
    }
  }

  async function handleAuthFailure(detail){
    await saveTokens(null);
    lastAuthResult = { status: 'error', reason: 'auth_failure', detail };
  }

  async function refreshAccessToken(){
    await ensureTokensDecrypted();
    if (!tokens || !tokens.refreshToken) throw new Error('No hay token de refresco');
    const appKey = getAppKey();
    if (!appKey) throw new Error('Falta el App Key de Dropbox');
    const body = new URLSearchParams({
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      client_id: appKey
    });
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      await handleAuthFailure(errText);
      throw new Error(`Refresh token Dropbox falló: ${errText}`);
    }
    const data = await response.json();
    tokens.accessToken = data.access_token;
    tokens.expiresAt = Date.now() + ((data.expires_in || 3600) - 30) * 1000;
    await saveTokens({ ...tokens });
  }

  async function ensureAccessToken(){
    await ensureTokensDecrypted();
    if (!tokens) throw new Error('Dropbox no está conectado');
    if (!tokens.expiresAt || tokens.expiresAt <= Date.now()) {
      await refreshAccessToken();
    }
    return tokens.accessToken;
  }

  function cleanupOAuthParams(){
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    const next = url.searchParams.toString();
    const clean = url.origin + url.pathname + (next ? `?${next}` : '') + url.hash;
    window.history.replaceState({}, document.title, clean);
  }

  async function handleRedirectIfPresent(){
    const params = new URLSearchParams(window.location.search);
    if (!params.has('code') && !params.has('error')) return;
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const incomingState = params.get('state');
    if (!expectedState || expectedState !== incomingState) {
      lastAuthResult = { status: 'error', reason: 'state_mismatch' };
      cleanupOAuthParams();
      return;
    }
    if (params.has('error')) {
      lastAuthResult = { status: 'error', reason: params.get('error') };
      cleanupOAuthParams();
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      return;
    }
    try {
      const code = params.get('code');
      await exchangeCode(code);
    } catch (err) {
      console.error(err);
      lastAuthResult = { status: 'error', reason: err.message };
      await saveTokens(null);
    } finally {
      cleanupOAuthParams();
    }
  }

  async function uploadBackup(filename, jsonString){
    await ensureTokensDecrypted();
    if (!tokens) throw new Error('Dropbox no está conectado');
    const accessToken = await ensureAccessToken();
    const apiArg = {
      path: `/Diario/${filename}`,
      mode: 'overwrite',
      autorename: false,
      mute: true
    };
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify(apiArg),
        'Content-Type': 'application/octet-stream'
      },
      body: jsonString
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('Dropbox upload falló', response.status, errText);
      if (response.status === 401 || response.status === 400) {
        await handleAuthFailure(errText);
      }
      throw new Error(`La subida a Dropbox falló: ${errText}`);
    }
    const metadata = await response.json();
    saveLastSync(Date.now());
    return metadata;
  }

  async function listBackups(){
    await ensureTokensDecrypted();
    if (!tokens) throw new Error('Dropbox no está conectado');
    const accessToken = await ensureAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    let url = 'https://api.dropboxapi.com/2/files/list_folder';
    let payload = { path: '/Diario', recursive: false, include_deleted: false, include_media_info: false };
    const entries = [];

    while (true) {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (response.status === 409) {
        // carpeta no encontrada => no hay backups aún
        return [];
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.warn('Dropbox list_folder falló', response.status, errText);
        if (response.status === 401 || response.status === 400) {
          await handleAuthFailure(errText);
        }
        throw new Error(`No se pudo listar backups en Dropbox: ${errText}`);
      }

      const data = await response.json();
      if (Array.isArray(data.entries)) {
        entries.push(...data.entries);
      }

      if (!data.has_more) break;
      url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
      payload = { cursor: data.cursor };
    }

    return entries
      .filter((item) => item['.tag'] === 'file' && item.name?.toLowerCase().endsWith('.json'))
      .sort((a, b) => new Date(b.server_modified || b.client_modified || 0) - new Date(a.server_modified || a.client_modified || 0));
  }

  async function downloadBackup(path){
    await ensureTokensDecrypted();
    if (!tokens) throw new Error('Dropbox no está conectado');
    const accessToken = await ensureAccessToken();
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path })
      }
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('Dropbox download falló', response.status, errText);
      if (response.status === 401 || response.status === 400) {
        await handleAuthFailure(errText);
      }
      throw new Error(`No se pudo descargar el backup: ${errText}`);
    }
    return response.text();
  }

  function getStatus(){
    return {
      linked: !!tokens || !!encryptedTokensRaw || !!pendingPlainTokens,
      pendingUnlock: !!pendingPlainTokens && !tokens && !encryptedTokensRaw,
      accountName: tokens?.accountName || null,
      email: tokens?.email || null,
      appKey: getAppKey(),
      lastSync
    };
  }

  function getAppKey(){
    return localStorage.getItem(APP_KEY_KEY) || '';
  }

  function setAppKey(value){
    if (value) {
      localStorage.setItem(APP_KEY_KEY, value);
    } else {
      localStorage.removeItem(APP_KEY_KEY);
    }
    notify();
  }

  return {
    init: async () => {
      await loadStoredTokens();
      const storedSync = Number(localStorage.getItem(LAST_SYNC_KEY));
      if (Number.isFinite(storedSync) && storedSync > 0) {
        lastSync = storedSync;
      }
      if (isCryptoUnlocked()) {
        if (pendingPlainTokens) {
          await saveTokens(pendingPlainTokens);
          pendingPlainTokens = null;
        } else {
          await ensureTokensDecrypted();
        }
      }
      await handleRedirectIfPresent();
      await ensureTokensDecrypted();
      if (tokens && (!tokens.accountName || !tokens.email)) {
        await hydrateAccountInfo();
      }
      if (pendingPlainTokens && !tokens && !encryptedTokensRaw) {
        lastAuthResult = lastAuthResult || { status: 'pending_unlock' };
      }
      notify();
    },
    connect: async (appKey) => {
      if (!appKey) throw new Error('Necesitas tu App Key de Dropbox');
      if (!isCryptoUnlocked()) {
        throw new Error('Desbloquea el diario antes de iniciar la conexión con Dropbox.');
      }
      setAppKey(appKey);
      const { verifier, challenge } = await generatePkce();
      const state = randomString(16);
      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);
      const redirectUri = getRedirectUri();
      const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', appKey);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('token_access_type', 'offline');
      authUrl.searchParams.set('scope', 'files.content.write files.content.read account_info.read');
      window.location.href = authUrl.toString();
    },
    disconnect: async () => {
      await saveTokens(null);
      saveLastSync(null);
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(PLAIN_PENDING_KEY);
      lastAuthResult = { status: 'disconnected' };
      notify();
    },
    uploadBackup,
    listBackups,
    downloadBackup,
    subscribe: (fn) => {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getStatus,
    isLinked: () => !!tokens || !!encryptedTokensRaw,
    getLastAuthResult: () => lastAuthResult,
    setAppKey,
    getAppKey,
    markAuthNoticeHandled: () => { lastAuthResult = null; },
    getLastSync: () => lastSync,
    onSessionUnlocked: async () => {
      const hadTokens = !!tokens;
      const hadPending = !!pendingPlainTokens;
      if (pendingPlainTokens) {
        const result = await saveTokens(pendingPlainTokens);
        pendingPlainTokens = null;
        if (result === 'saved') {
          lastAuthResult = { status: 'linked' };
        }
      }
      const decrypted = await ensureTokensDecrypted();
      if (decrypted && (!hadTokens && !hadPending)) {
        notify();
      }
      if (tokens && (!tokens.accountName || !tokens.email)) {
        await hydrateAccountInfo();
      }
    }
  };
})();
