// Integración mínima con Dropbox usando OAuth PKCE, subida y restauración de backups
const DropboxSync = (function(){
  const STORAGE_KEY = 'diario_dropbox_tokens_v1';
  const APP_KEY_KEY = 'diario_dropbox_app_key';
  const STATE_KEY = 'diario_dropbox_oauth_state';
  const VERIFIER_KEY = 'diario_dropbox_pkce_verifier';
  const LAST_SYNC_KEY = 'diario_dropbox_last_sync';

  let tokens = null;
  let lastSync = null;
  let lastAuthResult = null;
  const listeners = new Set();

  function notify(){
    const state = getStatus();
    listeners.forEach((fn) => {
      try { fn(state); } catch (err) { console.error('Dropbox listener error', err); }
    });
  }

  function parseStoredTokens(){
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed) return null;
      return parsed;
    } catch (err) {
      console.error('No se pudieron leer los tokens guardados de Dropbox', err);
      return null;
    }
  }

  function saveTokens(next){
    tokens = next;
    if (next) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    notify();
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
    saveTokens(next);
    await hydrateAccountInfo();
    lastAuthResult = { status: 'linked' };
    notify();
  }

  async function hydrateAccountInfo(){
    if (!tokens || !tokens.accessToken) return;
    try {
      const response = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 400) {
          await handleAuthFailure();
        }
        return;
      }
      const info = await response.json();
      tokens.accountName = info.name?.display_name || null;
      tokens.email = info.email || null;
      saveTokens(tokens);
    } catch (err) {
      console.warn('No se pudo obtener la cuenta de Dropbox', err);
    }
  }

  async function handleAuthFailure(){
    saveTokens(null);
    lastAuthResult = { status: 'error', reason: 'auth_failure' };
  }

  async function refreshAccessToken(){
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
      await handleAuthFailure();
      const errText = await response.text();
      throw new Error(`Refresh token Dropbox falló: ${errText}`);
    }
    const data = await response.json();
    tokens.accessToken = data.access_token;
    tokens.expiresAt = Date.now() + ((data.expires_in || 3600) - 30) * 1000;
    saveTokens(tokens);
  }

  async function ensureAccessToken(){
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
      saveTokens(null);
    } finally {
      cleanupOAuthParams();
    }
  }

  async function uploadBackup(filename, jsonString){
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
      if (response.status === 401) {
        await handleAuthFailure();
      }
      const errText = await response.text();
      throw new Error(`La subida a Dropbox falló: ${errText}`);
    }
    const metadata = await response.json();
    saveLastSync(Date.now());
    return metadata;
  }

  async function listBackups(){
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
        const errText = await response.text();
        if (response.status === 401 || response.status === 400) {
          await handleAuthFailure();
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
      if (response.status === 401 || response.status === 400) {
        await handleAuthFailure();
      }
      const errText = await response.text();
      throw new Error(`No se pudo descargar el backup: ${errText}`);
    }
    return response.text();
  }

  function getStatus(){
    return {
      linked: !!tokens,
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
      tokens = parseStoredTokens();
      const storedSync = Number(localStorage.getItem(LAST_SYNC_KEY));
      if (Number.isFinite(storedSync) && storedSync > 0) {
        lastSync = storedSync;
      }
      await handleRedirectIfPresent();
      if (tokens && (!tokens.accountName || !tokens.email)) {
        await hydrateAccountInfo();
      }
      notify();
    },
    connect: async (appKey) => {
      if (!appKey) throw new Error('Necesitas tu App Key de Dropbox');
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
    disconnect: () => {
      saveTokens(null);
      saveLastSync(null);
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
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
    isLinked: () => !!tokens,
    getLastAuthResult: () => lastAuthResult,
    setAppKey,
    getAppKey,
    markAuthNoticeHandled: () => { lastAuthResult = null; },
    getLastSync: () => lastSync
  };
})();
