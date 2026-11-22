// Post images (Sculptex renders, uploads) live in IndexedDB, not localStorage.
// localStorage holds ~5 MB per site; a few inline renders used to fill it, every save then failed and a reload
// fell back to an old state. Saved state now keeps a short "idb:<key>" reference instead of the image.

const DB_NAME = 'lens-images';
const STORE = 'images';
let opening = null;

function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB request aborted'));
  }));
}

export function putImage(key, value) {
  return run('readwrite', (store) => store.put(value, key));
}

export function getImage(key) {
  return run('readonly', (store) => store.get(key));
}

export function clearImages() {
  return run('readwrite', (store) => store.clear());
}

/** Short, stable key for an image data URL (FNV-1a over the content, plus its length). */
export function imageKey(value) {
  let h = 0x811c9dc5;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `img_${h.toString(36)}_${s.length.toString(36)}`;
}
