// Utilidades criptográficas: derivación PBKDF2 + AES-GCM con compatibilidad hacia atrás
const Crypto = (function(){
  const SALT_KEY = 'diario_salt';
  const KEY_INFO = 'diario_key';
  let keyHandle = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bufferToBase64(buffer){
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(str){
    const binary = atob(str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function ensureSaltBase64(){
    let stored = localStorage.getItem(SALT_KEY);
    if (!stored){
      const fresh = crypto.getRandomValues(new Uint8Array(16));
      stored = bufferToBase64(fresh.buffer);
      localStorage.setItem(SALT_KEY, stored);
    }
    return stored;
  }

  function setSaltBase64(value){
    if (typeof value !== 'string' || !value.length) throw new Error('Salt inválida');
    localStorage.setItem(SALT_KEY, value);
  }

  async function deriveKey(password, saltBytes){
    const salt = saltBytes || base64ToBytes(ensureSaltBase64());
    const pwKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      pwKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function loadVerifier(){
    const raw = localStorage.getItem(KEY_INFO);
    if (!raw) return null;
    try{
      const info = JSON.parse(raw);
      if (!info) return null;
      if (Array.isArray(info.iv) && Array.isArray(info.ct)){
        return {
          iv: new Uint8Array(info.iv),
          ct: new Uint8Array(info.ct).buffer
        };
      }
      if (info.iv && info.ct){
        return {
          iv: base64ToBytes(info.iv),
          ct: base64ToBytes(info.ct).buffer
        };
      }
    }catch(err){
      console.error('No se pudo leer el verificador almacenado', err);
    }
    return null;
  }

  async function persistVerifier(key){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = encoder.encode('verify');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
    const record = {
      version: 1,
      iv: bufferToBase64(iv.buffer),
      ct: bufferToBase64(ciphertext)
    };
    localStorage.setItem(KEY_INFO, JSON.stringify(record));
  }

  function serializeVerifier(verifier){
    if (!verifier) return null;
    return JSON.stringify({
      iv: bufferToBase64(verifier.iv.buffer),
      ct: bufferToBase64(verifier.ct)
    });
  }

  function parseVerifier(raw){
    if (!raw) return null;
    let info = raw;
    if (typeof raw === 'string') {
      try {
        info = JSON.parse(raw);
      } catch (err) {
        return null;
      }
    }
    if (Array.isArray(info.iv) && Array.isArray(info.ct)){
      return {
        iv: new Uint8Array(info.iv),
        ct: new Uint8Array(info.ct).buffer
      };
    }
    if (info.iv && info.ct){
      return {
        iv: base64ToBytes(info.iv),
        ct: base64ToBytes(info.ct).buffer
      };
    }
    return null;
  }

  async function encryptWithKey(key, text){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
    return JSON.stringify({
      version: 1,
      iv: bufferToBase64(iv.buffer),
      ct: bufferToBase64(ciphertext)
    });
  }

  async function decryptWithKey(key, payload){
    let parsed;
    try{
      parsed = JSON.parse(payload);
    }catch(err){
      throw new Error('Entrada dañada');
    }
    let iv;
    let ciphertext;
    if (Array.isArray(parsed.iv) && Array.isArray(parsed.ct)){
      iv = new Uint8Array(parsed.iv);
      ciphertext = new Uint8Array(parsed.ct).buffer;
    }else{
      iv = base64ToBytes(parsed.iv);
      ciphertext = base64ToBytes(parsed.ct).buffer;
    }
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return decoder.decode(plaintext);
  }

  return {
    setPassword: async (password)=>{
      keyHandle = await deriveKey(password);
      await persistVerifier(keyHandle);
    },
    tryUnlock: async (password)=>{
      const verifier = await loadVerifier();
      if (!verifier) return false;
      try{
        const candidate = await deriveKey(password);
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: verifier.iv }, candidate, verifier.ct);
        keyHandle = candidate;
        return true;
      }catch(err){
        return false;
      }
    },
    hasKey: async ()=>{
      return !!(await loadVerifier());
    },
    isUnlocked: ()=>!!keyHandle,
    lock: ()=>{
      keyHandle = null;
    },
    encryptString: async (text)=>{
      if (!keyHandle) throw new Error('No hay sesión desbloqueada');
      return encryptWithKey(keyHandle, text);
    },
    decryptString: async (payload)=>{
      if (!keyHandle) throw new Error('No hay sesión desbloqueada');
      return decryptWithKey(keyHandle, payload);
    },
    exportState: async () => {
      const salt = ensureSaltBase64();
      const verifier = localStorage.getItem(KEY_INFO);
      if (!salt || !verifier) throw new Error('No hay contraseña configurada');
      return {
        version: 1,
        salt,
        verifier,
        iterations: 150000,
        hash: 'SHA-256'
      };
    },
    importState: async (state) => {
      if (!state || !state.salt || !state.verifier) throw new Error('Estado de clave inválido');
      setSaltBase64(state.salt);
      localStorage.setItem(KEY_INFO, typeof state.verifier === 'string' ? state.verifier : JSON.stringify(state.verifier));
      keyHandle = null;
    },
    createSession: async (state, password) => {
      if (!state || !state.salt || !state.verifier) throw new Error('Estado de clave incompleto');
      const verifier = parseVerifier(state.verifier);
      if (!verifier) throw new Error('Verificador inválido en el backup');
      const key = await deriveKey(password, base64ToBytes(state.salt));
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: verifier.iv }, key, verifier.ct);
      return {
        encryptString: (text) => encryptWithKey(key, text),
        decryptString: (payload) => decryptWithKey(key, payload),
        getKey: () => key,
        state
      };
    }
  };
})();
