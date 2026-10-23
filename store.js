/* 미팅 녹음 — 저장소 (IndexedDB)
 * meetings: 미팅 정보 / chunks: 녹음 조각 (녹음 중 5초마다 저장 → 앱이 꺼져도 녹음이 남음)
 */
(function (root) {
  'use strict';

  let dbPromise;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('meeting-recorder', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('meetings', { keyPath: 'id' });
          const chunks = db.createObjectStore('chunks', { autoIncrement: true });
          chunks.createIndex('bySeg', ['meetingId', 'seg']);
          chunks.createIndex('byMeeting', 'meetingId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function run(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let result;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const Store = {
    putMeeting: (m) => run('meetings', 'readwrite', (s) => s.put(m)),
    getMeeting: (id) => run('meetings', 'readonly', (s) => s.get(id)),
    allMeetings: () => run('meetings', 'readonly', (s) => s.getAll()),

    // iOS 호환을 위해 Blob 대신 ArrayBuffer로 저장한다
    async addChunk(meetingId, seg, blob) {
      const buf = await blob.arrayBuffer();
      return run('chunks', 'readwrite', (s) => s.add({ meetingId, seg, buf }));
    },

    async segmentBlob(meetingId, seg, type) {
      const rows = await run('chunks', 'readonly', (s) => s.index('bySeg').getAll([meetingId, seg]));
      return new Blob((rows || []).map((r) => r.buf), { type });
    },

    deleteMeeting(id) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(['meetings', 'chunks'], 'readwrite');
        t.objectStore('meetings').delete(id);
        const chunks = t.objectStore('chunks');
        const cur = chunks.index('byMeeting').openKeyCursor(IDBKeyRange.only(id));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { chunks.delete(c.primaryKey); c.continue(); }
        };
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }));
    },
  };

  root.Store = Store;
})(window);
