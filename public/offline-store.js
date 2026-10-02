// The tickets saved on this device, so My tickets opens without a connection: at the door,
// where the signal is often worst. IndexedDB, holding one snapshot for the signed-in user:
//
//   { userId, email, savedAt, bookings: [...], tickets: { [bookingId]: [{ seat, qr, ... }] } }
//
// Why not the service worker's cache? That cache outlives logins and is shared by everyone
// who uses the browser, so it only ever holds public files. This snapshot is personal: it's
// deleted on logout, and on login (so one account never sees another's tickets offline).
// Every call fails soft: in a private window IndexedDB may be missing, and pages carry on.

const DB_NAME = 'ticket-mng';
const STORE = 'saved';
const KEY = 'my-tickets';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Replace the saved snapshot. */
export const saveTickets = (snapshot) =>
  run('readwrite', (store) => store.put(snapshot, KEY)).catch(() => {});

/** The saved snapshot, or null. */
export const loadSavedTickets = () =>
  run('readonly', (store) => store.get(KEY)).then(
    (snapshot) => snapshot ?? null,
    () => null,
  );

/** Forget everything saved on this device. */
export const clearSavedTickets = () => run('readwrite', (store) => store.delete(KEY)).catch(() => {});
