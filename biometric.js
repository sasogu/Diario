// Gestión de registro y autenticación biométrica usando WebAuthn
const Biometric = (() => {
  const META_KEY = 'diario_bio_meta';
  const VAULT_KEY = 'diario_bio_vault';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bufferToBase64Url(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBuffer(value) {
    if (typeof value !== 'string') throw new Error('Valor base64 inválido');
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function isSupported() {
    return typeof window !== 'undefined' && typeof navigator !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && !!crypto?.subtle;
  }

  async function isAvailable() {
    if (!isSupported()) return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (err) {
      console.warn('No se pudo comprobar la disponibilidad del autenticador de plataforma', err);
      return false;
    }
  }

  function loadMeta() {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.credentialId !== 'string' || !parsed.publicKey) return null;
      return parsed;
    } catch (err) {
      console.warn('No se pudo analizar la configuración biométrica guardada', err);
      return null;
    }
  }

  function loadVault() {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') return null;
      return parsed;
    } catch (err) {
      console.warn('No se pudo analizar el almacén biométrico', err);
      return null;
    }
  }

  function persistMeta(meta) {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function persistVault(vault) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  }

  function clearStored() {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(VAULT_KEY);
  }

  function concatBuffers(a, b) {
    const bufferA = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bufferB = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const merged = new Uint8Array(bufferA.length + bufferB.length);
    merged.set(bufferA, 0);
    merged.set(bufferB, bufferA.length);
    return merged.buffer;
  }

  function buffersEqual(a, b) {
    const viewA = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const viewB = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (viewA.length !== viewB.length) return false;
    for (let i = 0; i < viewA.length; i++) {
      if (viewA[i] !== viewB[i]) return false;
    }
    return true;
  }

  function parseDerSignature(signature, size) {
    const bytes = signature instanceof ArrayBuffer ? new Uint8Array(signature) : new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
    if (bytes[0] !== 0x30) throw new Error('Firma DER ECDSA inválida');
    let offset = 1;
    let totalLength = bytes[offset++];
    if (totalLength & 0x80) {
      const numOctets = totalLength & 0x7f;
      totalLength = 0;
      for (let i = 0; i < numOctets; i++) {
        totalLength = (totalLength << 8) | bytes[offset++];
      }
    }

    if (bytes[offset++] !== 0x02) throw new Error('Firma DER: se esperaba entero para R');
    let rLength = bytes[offset++];
    while (rLength > 0 && bytes[offset] === 0x00) {
      offset += 1;
      rLength -= 1;
    }
    const rBytes = bytes.subarray(offset, offset + rLength);
    offset += rLength;

    if (bytes[offset++] !== 0x02) throw new Error('Firma DER: se esperaba entero para S');
    let sLength = bytes[offset++];
    while (sLength > 0 && bytes[offset] === 0x00) {
      offset += 1;
      sLength -= 1;
    }
    const sBytes = bytes.subarray(offset, offset + sLength);

    const raw = new Uint8Array(size * 2);
    const r = rBytes.length > size ? rBytes.slice(rBytes.length - size) : rBytes;
    const s = sBytes.length > size ? sBytes.slice(sBytes.length - size) : sBytes;
    raw.set(r, size - r.length);
    raw.set(s, size * 2 - s.length);
    return raw.buffer;
  }

  function getAlgorithmParams(alg) {
    if (alg === -7) {
      return {
        import: { name: 'ECDSA', namedCurve: 'P-256' },
        verify: { name: 'ECDSA', hash: { name: 'SHA-256' } },
        signatureSize: 32
      };
    }
    if (alg === -257) {
      return {
        import: { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
        verify: { name: 'RSASSA-PKCS1-v1_5' },
        signatureSize: null
      };
    }
    throw new Error('Algoritmo no soportado');
  }

  async function importVerificationKey(meta) {
    const params = getAlgorithmParams(meta.alg);
    return crypto.subtle.importKey(
      'jwk',
      meta.publicKey,
      params.import,
      false,
      ['verify']
    );
  }

  async function digest(data) {
    if (data instanceof ArrayBuffer) {
      return crypto.subtle.digest('SHA-256', data);
    }
    if (ArrayBuffer.isView(data)) {
      const view = data;
      const slice = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? view.buffer
        : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      return crypto.subtle.digest('SHA-256', slice);
    }
    throw new Error('Datos no válidos para hash');
  }

  function ensureSupported() {
    if (!isSupported()) {
      throw new Error('Este dispositivo no soporta autenticación biométrica WebAuthn.');
    }
  }

  async function deriveVaultKey(userHandle) {
    if (!userHandle || userHandle.byteLength === 0) {
      throw new Error('El autenticador no proporcionó un identificador de usuario.');
    }
    const hash = await digest(userHandle);
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function encryptSecret(secret, userHandle) {
    const key = await deriveVaultKey(userHandle);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(secret));
    return {
      iv: bufferToBase64Url(iv.buffer),
      ct: bufferToBase64Url(ciphertext)
    };
  }

  async function decryptSecret(vault, userHandle) {
    const key = await deriveVaultKey(userHandle);
    const iv = base64UrlToBuffer(vault.iv);
    const ct = base64UrlToBuffer(vault.ct);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ct);
    return decoder.decode(plaintext);
  }

  async function verifyAssertion(credential, meta, expectedChallenge) {
    if (!credential || credential.type !== 'public-key') {
      throw new Error('Credencial inválida');
    }
    const response = credential.response;
    if (!response) throw new Error('Respuesta de autenticación inválida');

    const rawId = credential.rawId;
    if (!buffersEqual(rawId, base64UrlToBuffer(meta.credentialId))) {
      throw new Error('El autenticador recibido no coincide con el registrado.');
    }

    const clientDataJSON = response.clientDataJSON;
    const clientDataText = decoder.decode(clientDataJSON);
    let clientData;
    try {
      clientData = JSON.parse(clientDataText);
    } catch (err) {
      throw new Error('No se pudo interpretar la respuesta del autenticador.');
    }

    if (clientData.type !== 'webauthn.get') {
      throw new Error('Respuesta WebAuthn inesperada.');
    }

    const receivedChallenge = clientData.challenge;
    if (expectedChallenge && receivedChallenge !== expectedChallenge) {
      throw new Error('El autenticador devolvió un reto inesperado.');
    }

    const origin = clientData.origin;
    if (origin !== window.location.origin) {
      throw new Error('El origen del autenticador no coincide.');
    }

    const authenticatorData = response.authenticatorData;
    if (!authenticatorData) throw new Error('Faltan datos del autenticador.');

    const authDataView = new Uint8Array(authenticatorData);
    if (authDataView.length < 37) {
      throw new Error('Datos del autenticador incompletos.');
    }

    const rpIdHash = authDataView.slice(0, 32);
    const expectedRpId = meta.rpId || window.location.hostname;
    const expectedRpHash = new Uint8Array(await digest(encoder.encode(expectedRpId)));
    if (!buffersEqual(rpIdHash, expectedRpHash)) {
      throw new Error('Los datos del autenticador no corresponden a este dominio.');
    }

    const flags = authDataView[32];
    const userPresent = (flags & 0x01) === 0x01;
    const userVerified = (flags & 0x04) === 0x04;
    if (!userPresent || !userVerified) {
      throw new Error('No se pudo verificar la presencia del usuario.');
    }

    const signature = response.signature;
    if (!signature) throw new Error('El autenticador no devolvió firma.');

    const params = getAlgorithmParams(meta.alg);
    const publicKey = await importVerificationKey(meta);
    let signatureForVerify = signature;
    if (params.signatureSize) {
      signatureForVerify = parseDerSignature(signature, params.signatureSize);
    }

    const clientHash = await digest(clientDataJSON);
    const dataToVerify = concatBuffers(authenticatorData, clientHash);
    const verified = await crypto.subtle.verify(
      params.verify,
      publicKey,
      signatureForVerify,
      dataToVerify
    );

    if (!verified) {
      throw new Error('La firma del autenticador no es válida.');
    }

    const userHandle = response.userHandle;
    if (!userHandle || userHandle.byteLength === 0) {
      throw new Error('El autenticador no devolvió un identificador de usuario.');
    }

    return { userHandle };
  }

  async function requestAssertion(meta) {
    ensureSupported();
    const challengeBytes = randomBytes(32);
    const challenge = bufferToBase64Url(challengeBytes.buffer);
    const allowCredential = {
      id: base64UrlToBuffer(meta.credentialId),
      type: 'public-key'
    };
    const transports = Array.isArray(meta.transports) && meta.transports.length ? meta.transports : null;
    if (transports) allowCredential.transports = transports;
    const allow = [allowCredential];
    const publicKey = {
      challenge: challengeBytes,
      allowCredentials: allow,
      timeout: 60000,
      userVerification: 'required',
      rpId: meta.rpId || window.location.hostname
    };
    const assertion = await navigator.credentials.get({ publicKey });
    return verifyAssertion(assertion, meta, challenge);
  }

  async function createCredential() {
    ensureSupported();
    const rpId = window.location.hostname;
    const challenge = randomBytes(32);
    const userId = randomBytes(32);
    const publicKey = {
      challenge,
      rp: {
        id: rpId,
        name: 'Diario'
      },
      user: {
        id: userId,
        name: 'diario-user',
        displayName: 'Diario'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      }
    };

    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) throw new Error('No se pudo crear la credencial biométrica.');

    const response = credential.response;
    if (!response) throw new Error('Respuesta de registro inválida');

    if (typeof response.getPublicKey !== 'function') {
      throw new Error('El navegador no devuelve la clave pública del autenticador.');
    }

    const publicKeyBuffer = response.getPublicKey();
    const alg = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : -7;
    const params = getAlgorithmParams(alg);
    const key = await crypto.subtle.importKey('spki', publicKeyBuffer, params.import, true, ['verify']);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', key);
    const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];

    return {
      credentialId: bufferToBase64Url(credential.rawId),
      publicKey: publicKeyJwk,
      transports,
      alg,
      rpId,
      userId: bufferToBase64Url(userId.buffer)
    };
  }

  async function enable(password) {
    if (typeof password !== 'string' || password.length < 1) {
      throw new Error('Introduce la contraseña para poder activar el desbloqueo rápido.');
    }
    ensureSupported();
    const meta = await createCredential();
    const assertion = await requestAssertion(meta);
    const vault = await encryptSecret(password, assertion.userHandle);
    persistMeta({ ...meta, createdAt: new Date().toISOString() });
    persistVault({ ...vault, version: 1, updatedAt: new Date().toISOString() });
  }

  async function unlock() {
    const meta = loadMeta();
    const vault = loadVault();
    if (!meta || !vault) {
      throw new Error('No hay un método biométrico configurado.');
    }
    const assertion = await requestAssertion(meta);
    return decryptSecret(vault, assertion.userHandle);
  }

  function disable() {
    clearStored();
  }

  return {
    isSupported,
    isAvailable,
    hasEnrollment: () => !!(loadMeta() && loadVault()),
    enable,
    disable,
    unlock,
    loadMeta
  };
})();
