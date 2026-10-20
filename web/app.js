import { api, ApiError, clearSession, ensureSession, getConfig, loadSession, session } from './js/api.js';
import { clearLocal, download, exportLocal, localJournal, localMood, settings } from './js/store.js';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  // Always text nodes: user and AI content is never parsed as HTML.
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

const dateFmt = new Intl.DateTimeFormat('fil-PH', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso) => dateFmt.format(new Date(iso));

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(settings.get().theme);

// ---------------------------------------------------------------------------
// Router (hash based, so one-time tokens in links never reach the server)
// ---------------------------------------------------------------------------
const views = ['home', 'kausap', 'journal', 'mood', 'grounding', 'pakawalan', 'tulong', 'privacy', 'account', 'settings', 'verify', 'reset'];
const onEnter = {};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { view: views.includes(path) ? path : 'home', params: new URLSearchParams(query) };
}

function route(initial = false) {
  let { view, params } = parseHash();
  if (view === 'verify' || view === 'reset') {
    handleTokenLink(view, params.get('token'));
    view = 'account';
  }
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== view;
  for (const a of document.querySelectorAll('.mainnav a')) {
    if (a.getAttribute('href') === `#/${view}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Move focus to the new view on navigation (not on first load, so the skip link stays first in tab order).
  if (!initial) $('#main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  onEnter[view]?.(params);
}
window.addEventListener('hashchange', () => route());

// ---------------------------------------------------------------------------
// Offline indicator
// ---------------------------------------------------------------------------
function updateOnline() {
  $('#offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

// ---------------------------------------------------------------------------
// Chat ("Kausap")
// ---------------------------------------------------------------------------
const chat = { history: [], busy: false, lastMessage: null };
const MAX_HISTORY_SENT = 8;

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? 'makikinig';
}

function addMessage(role, text, extra = '') {
  const node = el('div', { class: `msg ${role} ${extra}`.trim() }, text);
  $('#messages').append(node);
  node.scrollIntoView({ block: 'end', behavior: reducedMotion() ? 'auto' : 'smooth' });
  return node;
}

function renderQuota(q) {
  $('#chat-quota').textContent = q ? `Natitira ngayon: ${q.remainingToday}/${q.limitToday} · Left today` : '';
}

async function refreshChatState() {
  const consent = settings.get().aiConsent;
  $('#ai-consent').hidden = consent;
  $('#chat-panel').hidden = !consent;
  const cfg = await getConfig();
  $('#chat-input').maxLength = cfg.limits.maxMessageChars;
  if (!cfg.aiAvailable) {
    setStatus(
      $('#chat-status'),
      'Nagpapahinga muna ang AI. Bukas pa rin ang journal, mood at grounding. · The AI companion is resting; other tools still work.',
    );
  }
  if (consent && session()) {
    try {
      const s = await api('GET', '/api/ai/status');
      renderQuota(s.quota);
    } catch {
      /* quota display is optional */
    }
  }
}

async function sendChat(message) {
  if (chat.busy) return;
  chat.busy = true;
  const send = $('#chat-send');
  send.disabled = true;
  setStatus($('#chat-status'), 'Sumasagot si KARAMAY… · KARAMAY is replying…');
  try {
    await ensureSession();
    const res = await api('POST', '/api/ai/chat', { mode: selectedMode(), message, history: chat.history.slice(-MAX_HISTORY_SENT) });
    // The full reply is shown at once — no typewriter effect.
    addMessage('model', res.reply, res.source === 'safety' ? 'safety' : '');
    chat.history.push({ role: 'user', text: message }, { role: 'model', text: res.reply });
    if (res.safety?.showResources) $('#safety-card').hidden = false;
    renderQuota(res.quota);
    setStatus($('#chat-status'), '');
    chat.lastMessage = null;
  } catch (err) {
    chat.lastMessage = message;
    showChatError(err);
  } finally {
    chat.busy = false;
    send.disabled = false;
  }
}

function showChatError(err) {
  const code = err instanceof ApiError ? err.code : 'error';
  let text = err.message;
  if (code === 'quota_exceeded') {
    const reset = err.details.resetAt ? ` (${fmtDate(err.details.resetAt)})` : '';
    text = `${err.message}${reset}`;
  }
  const node = addMessage('system', text);
  const retryable = ['offline', 'ai_timeout', 'busy', 'rate_limited'].includes(code) || err.details?.retryable;
  if (retryable && chat.lastMessage) {
    node.append(
      el('button', { type: 'button', class: 'btn ghost retry', onclick: () => { node.remove(); sendChat(chat.lastMessage); } }, 'Subukan ulit · Retry'),
    );
  }
  if (['quota_exceeded', 'ai_unavailable', 'ai_budget_paused'].includes(code)) {
    node.append(el('div', {}, el('a', { href: '#/journal' }, 'Journal'), ' · ', el('a', { href: '#/grounding' }, 'Grounding'), ' · ', el('a', { href: '#/tulong' }, 'Tulong')));
  }
  setStatus($('#chat-status'), '');
}

function initChat() {
  const input = $('#chat-input');
  const counter = $('#chat-counter');
  input.addEventListener('input', () => (counter.textContent = `${input.value.length} / ${input.maxLength}`));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || chat.busy) return;
    addMessage('user', message);
    input.value = '';
    counter.textContent = `0 / ${input.maxLength}`;
    sendChat(message);
  });
  $('#chat-clear').addEventListener('click', () => {
    chat.history = [];
    $('#messages').replaceChildren();
    $('#safety-card').hidden = true;
    toast('Nabura na ang usapan sa device na ito. · Conversation cleared.');
  });
  $('#ai-consent-accept').addEventListener('click', () => {
    settings.set({ aiConsent: true });
    refreshChatState();
    input.focus();
  });
  onEnter.kausap = (params) => {
    const m = params.get('mode');
    const radio = m && document.querySelector(`input[name="mode"][value="${CSS.escape(m)}"]`);
    if (radio) radio.checked = true;
    refreshChatState();
  };
}

// ---------------------------------------------------------------------------
// Journal & mood (device-local by default; cloud only for accounts that opt in)
// ---------------------------------------------------------------------------
const PROMPTS = Object.fromEntries([...document.querySelectorAll('#journal-prompt option')].map((o) => [o.value, o.textContent]));

function useCloud() {
  return settings.get().storage === 'cloud' && session()?.kind === 'user';
}

function storageNote() {
  return useCloud()
    ? 'Naka-save sa cloud ng account mo (naka-encrypt sa server). · Saved to your account cloud (encrypted at rest).'
    : 'Naka-save sa device na ito lang. Hindi ito nakikita ng KARAMAY. · Saved on this device only; KARAMAY cannot see it.';
}

async function journalEntries() {
  if (useCloud()) return (await api('GET', '/api/journal?limit=50')).entries;
  return localJournal.list();
}

async function renderJournal() {
  $('#journal-storage-note').textContent = storageNote();
  const list = $('#journal-list');
  let entries = [];
  try {
    entries = await journalEntries();
  } catch (err) {
    setStatus($('#journal-status'), err.message, true);
  }
  list.replaceChildren(
    ...entries.map((e) =>
      el(
        'li',
        {},
        el('div', { class: 'entry-head' }, el('span', { class: 'entry-title' }, e.title || PROMPTS[e.promptId] || 'Walang pamagat'), el('span', { class: 'entry-date' }, fmtDate(e.createdAt))),
        el('p', { class: 'entry-body' }, e.body),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'btn ghost', onclick: () => editJournal(e) }, 'I-edit · Edit'),
          el('button', { type: 'button', class: 'btn danger', onclick: () => deleteJournal(e) }, 'Burahin · Delete'),
        ),
      ),
    ),
  );
  if (!entries.length) list.append(el('li', {}, 'Wala pang entry. Simulan sa isang gabay na tanong sa itaas. · No entries yet.'));
}

function editJournal(e) {
  $('#journal-id').value = e.id;
  $('#journal-prompt').value = e.promptId ?? '';
  $('#journal-entry-title').value = e.title ?? '';
  $('#journal-body').value = e.body;
  $('#journal-cancel').hidden = false;
  $('#journal-body').focus();
}

function resetJournalForm() {
  $('#journal-form').reset();
  $('#journal-id').value = '';
  $('#journal-cancel').hidden = true;
}

async function deleteJournal(e) {
  if (!confirm('Burahin ang entry na ito? Hindi na ito maibabalik. · Delete this entry permanently?')) return;
  try {
    if (useCloud()) await api('DELETE', `/api/journal/${encodeURIComponent(e.id)}`);
    else localJournal.remove(e.id);
    toast('Nabura na. · Deleted.');
    renderJournal();
  } catch (err) {
    setStatus($('#journal-status'), err.message, true);
  }
}

function initJournal() {
  $('#journal-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = $('#journal-body').value.trim();
    if (!body) return setStatus($('#journal-status'), 'Walang laman ang entry. · The entry is empty.', true);
    const entry = { title: $('#journal-entry-title').value.trim(), body, promptId: $('#journal-prompt').value || null, mood: null };
    const id = $('#journal-id').value;
    try {
      if (useCloud()) await api(id ? 'PUT' : 'POST', id ? `/api/journal/${encodeURIComponent(id)}` : '/api/journal', entry);
      else localJournal.save(id ? { ...entry, id } : entry);
      resetJournalForm();
      setStatus($('#journal-status'), 'Na-save. · Saved.');
      renderJournal();
    } catch (err) {
      setStatus($('#journal-status'), err.message === 'storage_unavailable' ? 'Hindi makapag-save sa device na ito. · This browser blocks local storage.' : err.message, true);
    }
  });
  $('#journal-cancel').addEventListener('click', resetJournalForm);
  $('#journal-prompt').addEventListener('change', () => {
    const p = $('#journal-prompt').value;
    if (p && !$('#journal-entry-title').value) $('#journal-entry-title').value = PROMPTS[p] ?? '';
  });
  onEnter.journal = renderJournal;
}

const MOOD_LABELS = { 1: 'Napakabigat', 2: 'Mabigat', 3: 'Katamtaman', 4: 'Magaan', 5: 'Masaya' };

async function renderMood() {
  let entries = [];
  try {
    entries = useCloud() ? (await api('GET', '/api/mood?limit=30')).entries : localMood.list().slice(0, 30);
  } catch (err) {
    setStatus($('#mood-status'), err.message, true);
  }
  $('#mood-list').replaceChildren(
    ...entries.map((m) =>
      el(
        'li',
        {},
        el('div', { class: 'entry-head' }, el('span', { class: 'entry-title' }, MOOD_LABELS[m.mood] ?? m.mood), el('span', { class: 'entry-date' }, fmtDate(m.createdAt))),
        m.note ? el('p', { class: 'entry-body' }, m.note) : '',
      ),
    ),
  );
}

function initMood() {
  $('#mood-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const picked = document.querySelector('input[name="mood"]:checked');
    if (!picked) return setStatus($('#mood-status'), 'Pumili muna ng isa. · Pick one first.', true);
    const note = $('#mood-note').value.trim();
    try {
      if (useCloud()) await api('POST', '/api/mood', { mood: Number(picked.value), note: note || null });
      else localMood.add(Number(picked.value), note);
      $('#mood-form').reset();
      setStatus($('#mood-status'), 'Salamat sa pag-check in. · Thanks for checking in.');
      renderMood();
    } catch (err) {
      setStatus($('#mood-status'), err.message, true);
    }
  });
  onEnter.mood = renderMood;
}

// ---------------------------------------------------------------------------
// Grounding & Pakawalan (fully local; nothing is stored or sent)
// ---------------------------------------------------------------------------
function initGrounding() {
  const steps = [
    'Tumingin sa paligid. Pangalanan ang 5 bagay na nakikita mo. · Name 5 things you can see.',
    'Pansinin ang 4 na bagay na nararamdaman ng katawan mo. · Notice 4 things you can feel.',
    'Makinig. Ano ang 3 tunog na naririnig mo? · Name 3 things you can hear.',
    'Ano ang 2 amoy na napapansin mo? · Name 2 things you can smell.',
    'Ano ang 1 lasa o bagay na pinasasalamatan mo ngayon? · Name 1 thing you can taste or are grateful for.',
    'Magaling. Huminga nang malalim. Nandito ka, ngayon. · Well done. Take a slow breath. You are here, now.',
  ];
  let i = -1;
  const show = () => {
    $('#ground-step').textContent = steps[i];
    $('#ground-next').textContent = i >= steps.length - 1 ? 'Tapos na · Done' : 'Susunod · Next';
    $('#ground-next').disabled = i >= steps.length - 1;
  };
  $('#ground-next').addEventListener('click', () => {
    i = Math.min(i + 1, steps.length - 1);
    show();
  });
  $('#ground-reset').addEventListener('click', () => {
    i = 0;
    show();
  });

  const phases = ['Huminga papasok · Breathe in', 'Pigilan · Hold', 'Ilabas · Breathe out', 'Pigilan · Hold'];
  let timer = null;
  let phase = 0;
  let count = 4;
  const circle = $('#breath-circle');
  const label = $('#breath-label');
  const tick = () => {
    label.textContent = `${phases[phase]} — ${count}`;
    if (!reducedMotion()) circle.classList.toggle('in', phase === 0 || phase === 1);
    count -= 1;
    if (count === 0) {
      count = 4;
      phase = (phase + 1) % 4;
    }
  };
  $('#breath-toggle').addEventListener('click', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      label.textContent = '';
      circle.classList.remove('in');
      $('#breath-toggle').textContent = 'Simulan · Start';
      return;
    }
    phase = 0;
    count = 4;
    tick();
    timer = setInterval(tick, 1000);
    $('#breath-toggle').textContent = 'Itigil · Stop';
  });
  onEnter.grounding = () => {};
}

function initRelease() {
  $('#release-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const area = $('#release-text');
    if (!area.value.trim()) return;
    const finish = () => {
      area.value = '';
      area.classList.remove('releasing');
      setStatus($('#release-status'), 'Pinakawalan mo na. Hindi ito na-save kahit saan. · Released. It was never saved.');
    };
    if (reducedMotion()) return finish();
    area.classList.add('releasing');
    setTimeout(finish, 320);
  });
}

// ---------------------------------------------------------------------------
// Privacy Center controls
// ---------------------------------------------------------------------------
function initPrivacy() {
  const status = $('#privacy-status');
  $('#export-local').addEventListener('click', () => download(`karamay-device-${new Date().toISOString().slice(0, 10)}.json`, exportLocal()));
  $('#export-server').addEventListener('click', async () => {
    if (!session()) return setStatus(status, 'Wala kang data sa server. · You have no server data.');
    try {
      const data = await api('GET', '/api/me/export');
      download(`karamay-server-${new Date().toISOString().slice(0, 10)}.json`, data);
      setStatus(status, 'Na-download na. · Downloaded.');
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
  $('#clear-local').addEventListener('click', () => {
    if (!confirm('Burahin ang lahat ng journal, mood at settings sa device na ito? · Delete all data on this device?')) return;
    clearLocal();
    applyTheme('system');
    setStatus(status, 'Nabura na ang data sa device na ito. · Device data deleted.');
  });
  $('#delete-server').addEventListener('click', async () => {
    if (!session()) return setStatus(status, 'Wala kang data sa server. · You have no server data.');
    const isUser = session().kind === 'user';
    if (!confirm('Permanenteng burahin ang lahat ng data mo sa server? · Permanently delete all your server data?')) return;
    const password = isUser ? prompt('Ilagay ang password para kumpirmahin · Enter your password to confirm') : undefined;
    if (isUser && !password) return;
    try {
      const res = await api('DELETE', '/api/me', { confirm: 'DELETE', ...(isUser ? { password } : {}) });
      clearSession();
      setStatus(status, res.subscriptionNotice ?? 'Nabura na ang data mo sa server. · Your server data is deleted.');
      refreshAccount();
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function refreshAccount() {
  const cfg = await getConfig();
  const s = session();
  const signedIn = s?.kind === 'user';
  $('#accounts-off').hidden = cfg.accountsEnabled;
  $('#account-forms').hidden = !cfg.accountsEnabled || signedIn;
  $('#signed-in').hidden = !signedIn;
  $('#guest-data-choice').hidden = s?.kind !== 'guest';
  $('#storage-cloud').disabled = !signedIn;
  $('#account-summary').textContent = signedIn
    ? 'Naka-log in ka gamit ang account mo. · You are signed in.'
    : 'Ginagamit mo ang KARAMAY bilang guest. Hindi kailangan ng account. · You are using KARAMAY as a guest.';
  if (signedIn) {
    $('#plan-line').textContent = s.tier === 'premium' ? `Premium hanggang ${fmtDate(s.premiumUntil)}` : 'Libreng plan · Free plan';
  }
}

let pendingResetToken = null;
async function handleTokenLink(kind, token) {
  history.replaceState(null, '', '#/account'); // drop the token from the address bar
  if (!token) return;
  if (kind === 'verify') {
    try {
      await api('POST', '/api/auth/verify', { token });
      toast('Na-verify na ang email mo. Puwede ka nang mag-log in. · Email verified; you can log in now.');
    } catch (err) {
      toast(err.message);
    }
  } else {
    pendingResetToken = token;
    $('#reset-form').hidden = false;
  }
}

function initAccount() {
  $('#register-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const status = $('#register-status');
    try {
      await api('POST', '/api/auth/register', { email: $('#register-email').value, password: $('#register-password').value });
      $('#register-form').reset();
      setStatus(status, 'Tingnan ang email mo para sa link. · Check your email for a link.');
    } catch (err) {
      setStatus(status, err.details?.fields ? 'Pakisuri ang email at password (hindi bababa sa 10 character). · Check your email and password (10+ characters).' : err.message, true);
    }
  });
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const status = $('#login-status');
    try {
      await loadSession();
      const guestData = document.querySelector('input[name="guestData"]:checked')?.value ?? 'merge';
      await api('POST', '/api/auth/login', { email: $('#login-email').value, password: $('#login-password').value, guestData });
      await api('GET', '/api/session');
      $('#login-form').reset();
      setStatus(status, '');
      toast('Naka-log in ka na. · Signed in.');
      refreshAccount();
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
  $('#forgot-btn').addEventListener('click', async () => {
    const email = $('#login-email').value || prompt('Email');
    if (!email) return;
    try {
      await api('POST', '/api/auth/password-reset/request', { email });
      setStatus($('#login-status'), 'Kung may account ang email na ito, may darating na link. · If an account exists, a link is on its way.');
    } catch (err) {
      setStatus($('#login-status'), err.message, true);
    }
  });
  $('#reset-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/auth/password-reset/confirm', { token: pendingResetToken, newPassword: $('#reset-password').value });
      pendingResetToken = null;
      $('#reset-form').hidden = true;
      toast('Napalitan na ang password. Mag-log in ulit. · Password changed; please log in.');
    } catch (err) {
      setStatus($('#reset-status'), err.message, true);
    }
  });
  $('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/session/logout', {}).catch(() => {});
    clearSession();
    settings.set({ storage: 'local' });
    refreshAccount();
  });
  $('#logout-all-btn').addEventListener('click', async () => {
    await api('POST', '/api/session/logout-all', {}).catch(() => {});
    clearSession();
    settings.set({ storage: 'local' });
    refreshAccount();
  });
  onEnter.account = refreshAccount;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function initSettings() {
  const form = $('#settings-form');
  const sync = () => {
    const s = settings.get();
    const theme = form.querySelector(`input[name="theme"][value="${CSS.escape(String(s.theme))}"]`);
    if (theme) theme.checked = true;
    const storage = form.querySelector(`input[name="storage"][value="${CSS.escape(String(s.storage))}"]`);
    if (storage) storage.checked = true;
    $('#storage-cloud').disabled = session()?.kind !== 'user';
  };
  form.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'theme') {
      settings.set({ theme: t.value });
      applyTheme(t.value);
    }
    if (t.name === 'storage') {
      settings.set({ storage: t.value });
      setStatus(
        $('#settings-status'),
        t.value === 'cloud'
          ? 'Ang mga bagong entry ay ise-save sa account mo. Hindi awtomatikong inililipat ang nasa device. · New entries go to your account; device entries stay on the device.'
          : 'Sa device na ito lang ise-save ang mga bagong entry. · New entries stay on this device.',
      );
    }
  });
  onEnter.settings = sync;
}

// ---------------------------------------------------------------------------
async function start() {
  updateOnline();
  initChat();
  initJournal();
  initMood();
  initGrounding();
  initRelease();
  initPrivacy();
  initAccount();
  initSettings();
  try {
    await loadSession(); // never creates a session; guests get one only when they use the AI or cloud features
  } catch {
    /* offline: local tools still work */
  }
  route(true);
}

start();
