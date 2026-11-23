// Local-first storage (IndexedDB). Rides and wrong-side reports live on the
// phone; syncing to the server is optional and explicit.
const DB_NAME = 'ridelens';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rides')) db.createObjectStore('rides', { keyPath: 'id' }).createIndex('startT', 'summary.startT');
      if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'id' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  all: async (store) => (await tx(store, 'readonly', (s) => s.getAll())) || [],
  async updateReport(key, update) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('reports', 'readwrite');
      const store = transaction.objectStore('reports');
      const get = store.get(key);
      let saved;
      get.onsuccess = () => {
        if (get.result) { saved = update(get.result); store.put(saved); }
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onabort = () => reject(transaction.error);
    });
  },
  setKv: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  getKv: (key) => tx('kv', 'readonly', (s) => s.get(key)),
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
