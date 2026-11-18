/* PAPUZ — сквозное шифрование личных чатов (WebCrypto) */

export const KDF_ITER = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ------------------------------------------------------------ пароль → ключ */

async function kekFromPassword(password, saltB64, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64d(saltB64), iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* -------------------------------------------------------------- личный ключ */

export async function createIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return pair;
}

export async function exportIdentity(pair) {
  const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return { pubKey: b64(pub), privBytes: new Uint8Array(priv) };
}

/** оборачивает приватный ключ паролем и готовит поле для сервера */
export async function wrapIdentity(pair, password) {
  const { pubKey, privBytes } = await exportIdentity(pair);
  const wrapped = await wrapPrivateBytes(privBytes, password);
  return { pubKey, ...wrapped };
}

/** то же, но для уже распакованных байтов ключа (смена пароля) */
export async function wrapPrivateBytes(privBytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdfSalt = b64(salt);
  const kek = await kekFromPassword(password, kdfSalt, KDF_ITER);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, privBytes);
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return { encPriv: b64(all), kdfSalt, kdfIter: KDF_ITER };
}

/** разворачивает приватный ключ паролем; бросает, если пароль не тот */
export async function unwrapIdentity(encPriv, kdfSalt, kdfIter, password) {
  const kek = await kekFromPassword(password, kdfSalt, kdfIter);
  const all = b64d(encPriv);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

/* ------------------------------------------------------------- ключ на чат */

const peerCache = new Map();

export async function importPeerKey(pubB64) {
  if (peerCache.has(pubB64)) return peerCache.get(pubB64);
  const key = await crypto.subtle.importKey('raw', b64d(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  peerCache.set(pubB64, key);
  return key;
}

export async function deriveChatKey(myPriv, peerPubB64, aId, bId) {
  const peer = await importPeerKey(peerPubB64);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, myPriv, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const lo = Math.min(aId, bId);
  const hi = Math.max(aId, bId);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('papuz-dm-v1'), info: enc.encode(`dm:${lo}:${hi}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* ------------------------------------------------------------- шифр текста */

export async function encryptText(chatKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chatKey, enc.encode(text));
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0);
  all.set(new Uint8Array(ct), iv.length);
  return 'v1:' + b64(all);
}

export async function decryptText(chatKey, payload) {
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) return null;
  try {
    const all = b64d(payload.slice(3));
    const iv = all.slice(0, 12);
    const ct = all.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, chatKey, ct);
    return dec.decode(plain);
  } catch {
    return null;
  }
}

export const isEncrypted = (s) => typeof s === 'string' && s.startsWith('v1:');
