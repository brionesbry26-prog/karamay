// Device-local storage. Every access is guarded: storage can be unavailable
// (private browsing, blocked site data) and the app must still work.

const KEYS = { journal: 'kmy.journal.v1', mood: 'kmy.mood.v1', settings: 'kmy.settings.v1' };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export const settings = {
  get() {
    return { theme: 'system', storage: 'local', aiConsent: false, ...read(KEYS.settings, {}) };
  },
  set(patch) {
    const next = { ...settings.get(), ...patch };
    write(KEYS.settings, next);
    return next;
  },
};

export const localJournal = {
  list() {
    return read(KEYS.journal, []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  save(entry) {
    const all = read(KEYS.journal, []);
    const now = new Date().toISOString();
    if (entry.id) {
      const i = all.findIndex((e) => e.id === entry.id);
      if (i >= 0) all[i] = { ...all[i], ...entry, updatedAt: now };
    } else {
      all.push({ ...entry, id: uid(), createdAt: now, updatedAt: now });
    }
    if (!write(KEYS.journal, all)) throw new Error('storage_unavailable');
  },
  remove(id) {
    write(KEYS.journal, read(KEYS.journal, []).filter((e) => e.id !== id));
  },
};

export const localMood = {
  list() {
    return read(KEYS.mood, []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  add(mood, note) {
    const all = read(KEYS.mood, []);
    all.push({ id: uid(), mood, note: note || null, createdAt: new Date().toISOString() });
    if (!write(KEYS.mood, all.slice(-1000))) throw new Error('storage_unavailable');
  },
  remove(id) {
    write(KEYS.mood, read(KEYS.mood, []).filter((e) => e.id !== id));
  },
};

export function exportLocal() {
  return {
    exportedAt: new Date().toISOString(),
    format: 'karamay-device-export-v1',
    journal: localJournal.list(),
    mood: localMood.list(),
  };
}

export function clearLocal() {
  try {
    for (const k of Object.values(KEYS)) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch {
    /* nothing stored */
  }
}

export function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
