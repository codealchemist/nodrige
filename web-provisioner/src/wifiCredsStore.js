// Encrypts Wi-Fi SSID/password with a non-extractable AES-GCM key before
// persisting to localStorage, so a returning user doesn't have to retype
// them. localStorage can only hold strings, but IndexedDB can hold an actual
// non-extractable CryptoKey via structured clone — so the AES key lives
// there (one row, one store), and localStorage holds only {iv, ciphertext}.
// Same crypto.subtle / non-extractable-key pattern protocol.js already uses.
//
// NOT a defense against an attacker who can already run JS on this page
// (XSS) — they could call loadSavedCreds() the same way this file does. It
// only raises the bar above "read the raw value": a devtools Application-tab
// glance, a browser extension with storage-read access, an unencrypted
// backup/sync of localStorage. Same inherent limit as any client-side
// "encryption at rest" without a user-supplied passphrase.

const DB_NAME = "web-provisioner";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_RECORD_ID = "wifiCredsKey";
const LOCAL_STORAGE_KEY = "web-provisioner.wifiCreds.v1";

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, id, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Memoized: a concurrent load+save racing at startup must await the SAME
// in-flight promise, or two different keys could get generated, silently
// orphaning whatever was encrypted under the first one.
let keyPromise = null;
function getOrCreateKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const db = await openDb();
      const existing = await idbGet(db, KEY_RECORD_ID);
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await idbPut(db, KEY_RECORD_ID, key);
      return key;
    })();
  }
  return keyPromise;
}

// Returns {ssid, password} or null (nothing saved yet, or the saved blob
// couldn't be decrypted — e.g. IndexedDB was cleared independently of
// localStorage). Never throws.
export async function loadSavedCreds() {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return null;
  try {
    const { iv, ciphertext } = JSON.parse(raw);
    const key = await getOrCreateKey();
    const plaintextBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      key,
      base64ToBytes(ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintextBytes));
  } catch (err) {
    console.warn("Discarding unreadable saved Wi-Fi credentials:", err.message);
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    return null;
  }
}

// Best-effort — swallows failures (e.g. IndexedDB unavailable) rather than
// throwing, since losing persistence must never break provisioning itself.
export async function saveCreds(ssid, password) {
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV every call — required for AES-GCM key-reuse safety
    const plaintextBytes = new TextEncoder().encode(JSON.stringify({ ssid, password }));
    const ciphertextBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes));
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertextBytes) })
    );
  } catch (err) {
    console.warn("Could not save Wi-Fi credentials:", err.message);
  }
}

export function clearSavedCreds() {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}
