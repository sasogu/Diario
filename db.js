// Wrapper simple para IndexedDB con utilidades básicas
const DB = (function () {
  const NAME = 'diario-db';
  const STORE = 'entries';
  let db = null;

  function getStore(mode) {
    if (!db) throw new Error('DB no inicializada');
    const tx = db.transaction(STORE, mode);
    return tx.objectStore(STORE);
  }

  return {
    open: () => new Promise((resolve, reject) => {
      if (db) return resolve();
      const request = indexedDB.open(NAME, 2);
      request.onupgradeneeded = (event) => {
        const instance = event.target.result;
        if (!instance.objectStoreNames.contains(STORE)) {
          instance.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        } else if (event.oldVersion < 2) {
          const store = event.target.transaction.objectStore(STORE);
          if (!store.indexNames.contains('createdAt')) {
            store.createIndex('createdAt', 'createdAt');
          }
        }
      };
      request.onsuccess = (event) => {
        db = event.target.result;
        db.onclose = () => { db = null; };
        resolve();
      };
      request.onerror = (event) => reject(event.target.error);
    }),
    saveEntry: (obj) => new Promise((resolve, reject) => {
      try {
        const store = getStore('readwrite');
        const request = store.add(obj);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
      } catch (err) {
        reject(err);
      }
    }),
    listEntries: () => new Promise((resolve, reject) => {
      try {
        const store = getStore('readonly');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (event) => reject(event.target.error);
      } catch (err) {
        reject(err);
      }
    }),
    deleteEntry: (id) => new Promise((resolve, reject) => {
      try {
        const store = getStore('readwrite');
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
      } catch (err) {
        reject(err);
      }
    })
  };
})();
