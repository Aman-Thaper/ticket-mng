// What the door scanner keeps on the device, so it works with no signal (IndexedDB):
//
//   scans: one record per ticket admitted on this device, by ticket id:
//          { ticketId, eventId, token, label, scannedAt, synced, problem? }
//          A second scan of the same ticket is caught here, offline. Scans made offline
//          (synced: false) are sent to the server when the connection returns.
//   meta:  the public key for checking ticket signatures, and the organizer's events.
//
// Kept apart from the attendee's saved tickets (offline-store.js): check-ins that haven't
// reached the server yet must survive a logout, or people admitted at the door would never
// be recorded. Synced records are pruned after two days.

const DB_NAME = 'ticket-mng-scanner';
const PRUNE_AFTER_MS = 2 * 86_400_000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const scans = request.result.createObjectStore('scans', { keyPath: 'ticketId' });
      scans.createIndex('synced', 'synced');
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(storeName, mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const getScan = (ticketId) => run('scans', 'readonly', (s) => s.get(ticketId));
export const putScan = (scan) => run('scans', 'readwrite', (s) => s.put(scan));
export const allScans = () => run('scans', 'readonly', (s) => s.getAll());

/** Check-ins made offline that the server hasn't heard about yet. */
export async function unsyncedScans() {
  return (await allScans()).filter((scan) => !scan.synced);
}

/** Forget synced scans older than two days. Unsynced ones are never dropped. */
export async function pruneScans() {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const old = (await allScans()).filter((scan) => scan.synced && Date.parse(scan.scannedAt) < cutoff);
  await Promise.all(old.map((scan) => run('scans', 'readwrite', (s) => s.delete(scan.ticketId))));
}

export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));
