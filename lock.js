/*
 * The app lock. Everything Eagle Creek keeps on this device (the sign-in, every record, every
 * photo and document copy) is encrypted with a key that lives only in memory while the app is
 * unlocked. The key is wrapped by a 6-digit PIN (PBKDF2, 310,000 rounds) and, when the device
 * can do it, by Face ID / Touch ID through a WebAuthn passkey's PRF output, so the PIN or the
 * face unwraps the same key. Locking throws the key away; what's on the device is then
 * ciphertext until the next unlock. Ten wrong PINs, or two weeks without an unlock, erase the
 * device's copy (the books stay safe in the cloud). Loaded before app.js; it uses nothing from
 * app.js until the app calls it.
 */

const LOCK = {
  key: null, // the device key (AES-GCM 256), while unlocked
  config: null, // { v, pin: {salt, iter, iv, wrapped}, bio: {credID, salt, iv, wrapped} | null, timeout, email }
  state: { failed: 0, nextTryAt: 0, lastUnlockAt: 0, hiddenAt: 0 }, // plain, so a locked app can read it
  ENC_STORES: new Set(['docs', 'blobs', 'cache']),
  ENC_KV: new Set(['session', 'meta', 'team']),
  PIN_ITERATIONS: 310_000,
  MAX_FAILED: 10,
  EXPIRY_DAYS: 14,
  TIMEOUTS: [[0, 'Right away'], [60, 'After 1 minute'], [120, 'After 2 minutes'], [300, 'After 5 minutes'], [900, 'After 15 minutes']],
  onUnlock: null, // set by app.js: what to do once the key is back
  onWipe: null,
};

// ---------------------------------------------------------------------------
// Bytes and keys

const lockBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const lockText = { enc: new TextEncoder(), dec: new TextDecoder() };

async function lockPinKEK(pin, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', lockText.enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function lockBioKEK(prfOutput) {
  // The authenticator's PRF output is high-entropy already; HKDF just shapes it into a key.
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: lockText.enc.encode('eaglecreek-lock'), info: lockText.enc.encode('device-key') }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function lockWrap(deviceKey, kek) {
  const iv = lockBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', deviceKey, kek, { name: 'AES-GCM', iv });
  return { iv, wrapped: new Uint8Array(wrapped) };
}

async function lockUnwrap(entry, kek) {
  return crypto.subtle.unwrapKey('raw', entry.wrapped, kek, { name: 'AES-GCM', iv: entry.iv }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** A fresh device key (extractable, so Face ID can be added later while the PIN is known). */
const lockNewKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

// ---------------------------------------------------------------------------
// Sealing what's stored

/** Whether values are sealed on the way to IndexedDB (a lock is set up). */
LOCK.enabled = () => !!LOCK.config;
LOCK.isLocked = () => LOCK.enabled() && !LOCK.key;
LOCK.seals = (store, k) => LOCK.enabled() && (LOCK.ENC_STORES.has(store) || (store === 'kv' && LOCK.ENC_KV.has(k)));

async function lockToBytes(v) {
  if (v instanceof Blob) return { bytes: new Uint8Array(await v.arrayBuffer()), meta: { t: 'blob', type: v.type || '' } };
  if (v && typeof v === 'object' && v.blob instanceof Blob) {
    const rest = { ...v };
    delete rest.blob;
    return { bytes: new Uint8Array(await v.blob.arrayBuffer()), meta: { t: 'objblob', type: v.blob.type || '', rest } };
  }
  return { bytes: lockText.enc.encode(JSON.stringify(v === undefined ? null : v)), meta: { t: 'json' } };
}

function lockFromBytes(bytes, meta) {
  if (meta.t === 'blob') return new Blob([bytes], { type: meta.type });
  if (meta.t === 'objblob') return { ...meta.rest, blob: new Blob([bytes], { type: meta.type }) };
  return JSON.parse(lockText.dec.decode(bytes));
}

LOCK.seal = async (v) => {
  if (!LOCK.key) throw new Error('The app is locked.');
  const { bytes, meta } = await lockToBytes(v);
  const iv = lockBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, LOCK.key, bytes);
  return { __enc: 1, iv, ct: new Uint8Array(ct), meta };
};

LOCK.open = async (v) => {
  if (!v || typeof v !== 'object' || v.__enc !== 1) return v; // plain (from before the lock was set up)
  if (!LOCK.key) throw new Error('The app is locked.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv }, LOCK.key, v.ct);
  return lockFromBytes(new Uint8Array(pt), v.meta || { t: 'json' });
};

// ---------------------------------------------------------------------------
// Setting up, unlocking, locking

const LOCK_KV = { config: 'lock', state: 'lock-state' };

LOCK.load = async (rawIDB) => {
  LOCK.raw = rawIDB;
  LOCK.config = (await rawIDB.get('kv', LOCK_KV.config)) || null;
  LOCK.state = { failed: 0, nextTryAt: 0, lastUnlockAt: 0, hiddenAt: 0, ...((await rawIDB.get('kv', LOCK_KV.state)) || {}) };
};

LOCK.saveState = async () => { await LOCK.raw.set('kv', LOCK_KV.state, { ...LOCK.state }); };

/** Two weeks without an unlock: the device's copy goes. */
LOCK.isExpired = () => LOCK.enabled() && LOCK.state.lastUnlockAt > 0 && Date.now() - LOCK.state.lastUnlockAt > LOCK.EXPIRY_DAYS * 86_400_000;

/**
 * Sets the PIN for the first time, with a new device key, and seals everything already stored
 * on the device (records, photos, the sign-in) with it.
 */
LOCK.setUp = async (pin, { email = '', timeout = 120 } = {}) => {
  const deviceKey = await lockNewKey();
  const salt = lockBytes(16);
  const kek = await lockPinKEK(pin, salt, LOCK.PIN_ITERATIONS);
  const pinEntry = { salt, iter: LOCK.PIN_ITERATIONS, ...(await lockWrap(deviceKey, kek)) };
  LOCK.key = deviceKey;
  LOCK.config = { v: 1, pin: pinEntry, bio: null, timeout, email, createdAt: Date.now() };
  await LOCK.sealEverything();
  await LOCK.raw.set('kv', LOCK_KV.config, LOCK.config);
  LOCK.state = { failed: 0, nextTryAt: 0, lastUnlockAt: Date.now(), hiddenAt: 0 };
  await LOCK.saveState();
};

/** Re-writes every stored value sealed (after setup, or when a plain value is found later). */
LOCK.sealEverything = async () => {
  const raw = LOCK.raw;
  for (const store of LOCK.ENC_STORES) {
    const rows = await raw.all(store);
    const puts = [];
    for (const [k, v] of rows) if (!(v && v.__enc === 1)) puts.push([k, await LOCK.seal(v)]);
    for (let i = 0; i < puts.length; i += 200) await raw.batch(store, puts.slice(i, i + 200));
  }
  for (const k of LOCK.ENC_KV) {
    const v = await raw.get('kv', k);
    if (v !== undefined && !(v && v.__enc === 1)) await raw.set('kv', k, await LOCK.seal(v));
  }
};

/** How long until the next PIN try is allowed (0 when now). */
LOCK.waitSeconds = () => Math.max(0, Math.ceil((LOCK.state.nextTryAt - Date.now()) / 1000));

/** Tries a PIN. Resolves true when unlocked; false when wrong (and counts it). Throws when wiped. */
LOCK.unlockWithPIN = async (pin) => {
  if (LOCK.waitSeconds() > 0) return false;
  try {
    const kek = await lockPinKEK(pin, LOCK.config.pin.salt, LOCK.config.pin.iter);
    LOCK.key = await lockUnwrap(LOCK.config.pin, kek);
  } catch {
    return LOCK.countFailure();
  }
  await LOCK.unlocked();
  return true;
};

LOCK.countFailure = async () => {
  LOCK.state.failed = (LOCK.state.failed || 0) + 1;
  if (LOCK.state.failed >= LOCK.MAX_FAILED) {
    await LOCK.wipe(`The PIN was wrong ${LOCK.MAX_FAILED} times, so everything on this device was erased. Your books are safe in the cloud: sign in again.`);
    throw new Error('wiped');
  }
  // From the fifth wrong PIN: 30 s, then doubling, up to 15 minutes.
  if (LOCK.state.failed >= 5) LOCK.state.nextTryAt = Date.now() + Math.min(900, 30 * 2 ** (LOCK.state.failed - 5)) * 1000;
  await LOCK.saveState();
  return false;
};

LOCK.unlocked = async () => {
  LOCK.state.failed = 0;
  LOCK.state.nextTryAt = 0;
  LOCK.state.lastUnlockAt = Date.now();
  LOCK.state.hiddenAt = 0;
  await LOCK.saveState();
};

/** Locks: the key goes, and the app shows the lock screen. */
LOCK.lock = async () => {
  if (!LOCK.enabled() || !LOCK.key) return;
  LOCK.key = null;
  if (LOCK.onLock) await LOCK.onLock();
};

/** Changes the PIN (the current one proves it's you). */
LOCK.changePIN = async (currentPin, newPin) => {
  const kek = await lockPinKEK(currentPin, LOCK.config.pin.salt, LOCK.config.pin.iter);
  let deviceKey;
  try { deviceKey = await lockUnwrap(LOCK.config.pin, kek); } catch { return false; }
  const salt = lockBytes(16);
  const next = await lockPinKEK(newPin, salt, LOCK.PIN_ITERATIONS);
  LOCK.config = { ...LOCK.config, pin: { salt, iter: LOCK.PIN_ITERATIONS, ...(await lockWrap(deviceKey, next)) } };
  await LOCK.raw.set('kv', LOCK_KV.config, LOCK.config);
  return true;
};

LOCK.setTimeout = async (seconds) => {
  if (!LOCK.config) return;
  LOCK.config = { ...LOCK.config, timeout: Number(seconds) || 0 };
  await LOCK.raw.set('kv', LOCK_KV.config, LOCK.config);
};

/** Erases everything the app keeps on this device (the Supabase address stays, for signing in again). */
LOCK.wipe = async (reason) => {
  LOCK.key = null;
  LOCK.config = null;
  LOCK.state = { failed: 0, nextTryAt: 0, lastUnlockAt: 0, hiddenAt: 0 };
  const raw = LOCK.raw;
  for (const store of ['docs', 'blobs', 'cache']) await raw.clear(store);
  for (const k of ['session', 'meta', 'team', LOCK_KV.config, LOCK_KV.state]) await raw.del('kv', k);
  if (LOCK.onWipe) await LOCK.onWipe(reason);
};

// ---------------------------------------------------------------------------
// Face ID / Touch ID (a platform passkey whose PRF output wraps the device key)

LOCK.bioPossible = async () => {
  try {
    return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
};

LOCK.bioEnabled = () => !!LOCK.config?.bio;

const lockPRFSalt = () => lockText.enc.encode('eaglecreek-device-key-v1');

/**
 * Enrolls Face ID / Touch ID: the current PIN unwraps the device key, a passkey is made, and its
 * PRF output wraps the key again. Resolves 'ok', 'wrong-pin', or 'unsupported' (no PRF here).
 */
LOCK.enrollBiometric = async (pin) => {
  const kek = await lockPinKEK(pin, LOCK.config.pin.salt, LOCK.config.pin.iter);
  let deviceKey;
  try { deviceKey = await lockUnwrap(LOCK.config.pin, kek); } catch { return 'wrong-pin'; }
  const userID = lockBytes(16);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Eagle Creek', id: location.hostname },
        user: { id: userID, name: LOCK.config.email || 'eaglecreek', displayName: 'Eagle Creek' },
        challenge: lockBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        timeout: 60_000,
        extensions: { prf: {} },
      },
    });
  } catch (e) {
    if (e?.name === 'NotAllowedError') return 'cancelled';
    return 'unsupported';
  }
  const made = cred.getClientExtensionResults?.() || {};
  if (!made.prf?.enabled) return 'unsupported';
  const credID = new Uint8Array(cred.rawId);
  const output = await lockPRFOutput(credID);
  if (!output) return 'unsupported';
  const bioKEK = await lockBioKEK(output);
  LOCK.config = { ...LOCK.config, bio: { credID, ...(await lockWrap(deviceKey, bioKEK)) } };
  await LOCK.raw.set('kv', LOCK_KV.config, LOCK.config);
  return 'ok';
};

async function lockPRFOutput(credID) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: lockBytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credID }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: lockPRFSalt() } } },
    },
  });
  const results = assertion.getClientExtensionResults?.() || {};
  const first = results.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** Unlocks with Face ID / Touch ID. Resolves true when unlocked. */
LOCK.unlockWithBiometric = async () => {
  if (!LOCK.bioEnabled()) return false;
  try {
    const output = await lockPRFOutput(LOCK.config.bio.credID);
    if (!output) return false;
    const kek = await lockBioKEK(output);
    LOCK.key = await lockUnwrap(LOCK.config.bio, kek);
  } catch {
    return false;
  }
  await LOCK.unlocked();
  return true;
};

LOCK.removeBiometric = async () => {
  if (!LOCK.config) return;
  LOCK.config = { ...LOCK.config, bio: null };
  await LOCK.raw.set('kv', LOCK_KV.config, LOCK.config);
};

// ---------------------------------------------------------------------------
// Screens (plain HTML; app.js renders them into #main and wires the keypad)

function lockKeypad(id, title, hint) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
  return `<div class="lock" id="${id}">
    <img class="logo" src="icon-180.png" alt="">
    <h1>${title}</h1>
    <p class="lock-hint">${hint}</p>
    <div class="pin-dots" aria-live="polite">${'<i></i>'.repeat(6)}</div>
    <div class="keypad">${keys.map((k) => (k === '' ? '<span></span>' : `<button type="button" data-key="${k}" aria-label="${k === 'back' ? 'Delete' : k}">${k === 'back' ? '⌫' : k}</button>`)).join('')}</div>
    <p class="lock-err" role="alert"></p>
    <div class="lock-foot"></div>
  </div>`;
}

LOCK.setupHTML = (email) => lockKeypad('lock-setup', 'Set a PIN', `Your books, bank lines and photos on this device are kept encrypted behind it. Six digits.${email ? ` Signed in as ${email}.` : ''}`);
LOCK.confirmHTML = () => lockKeypad('lock-confirm', 'Enter It Again', 'The same six digits, to be sure.');
LOCK.lockHTML = () => {
  const wait = LOCK.waitSeconds();
  return lockKeypad('lock-screen', 'Eagle Creek', wait > 0 ? `Wait ${wait} seconds before trying again.` : 'Enter your PIN.');
};

/**
 * Wires a keypad: digits fill the dots; at six, `onPIN(pin)` runs and resolves to an error
 * message (shown, pin cleared) or nothing (done).
 */
LOCK.wire = (root, onPIN) => {
  let pin = '';
  const dots = root.querySelectorAll('.pin-dots i');
  const err = root.querySelector('.lock-err');
  const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
  root.querySelector('.keypad').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    const k = b.dataset.key;
    if (k === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 6) pin += k;
    paint();
    if (pin.length === 6) {
      const entered = pin;
      root.classList.add('busy');
      // onPIN resolves to: null/undefined (done), '' (next step: clear the dots), or an error to show.
      const message = await onPIN(entered);
      root.classList.remove('busy');
      if (message === null || message === undefined) return;
      pin = '';
      paint();
      err.textContent = message;
      if (message) {
        root.classList.add('shake');
        setTimeout(() => root.classList.remove('shake'), 400);
      }
    }
  });
};
