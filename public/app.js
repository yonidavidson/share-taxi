// app.js — לוגיקת הצד-לקוח עבור "מונית משותפת · רעננה"
'use strict';

// ------------------------------------------------------------------
// נקודות המסלול הקבועות: שתי תחנות רכבת ⇄ אזור תעשייה גב-ים
// ------------------------------------------------------------------
const GAV_YAM = 'גב-ים רעננה';
const STATIONS = [
  { key: 'raananaSouth', short: 'רעננה דרום', full: 'רכבת רעננה דרום' },
  { key: 'raananaWest', short: 'רעננה מערב', full: 'רכבת רעננה מערב' },
  { key: 'herzliya', short: 'הרצליה', full: 'רכבת הרצליה' },
];

// הערכת נסיעה ברכב/מונית אל גב-ים רעננה (חושבה מראש) — לתצוגה על הכרטיסים
const TAXI = {
  raananaSouth: { km: 5.6, min: 10 },
  raananaWest: { km: 5.7, min: 10 },
  herzliya: { km: 9.4, min: 15 },
};

// ------------------------------------------------------------------
// זיהוי אנונימי — טוקן אקראי שנשמר רק בדפדפן שלך
// ------------------------------------------------------------------
function getToken() {
  let t = localStorage.getItem('st_token');
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    localStorage.setItem('st_token', t);
  }
  return t;
}

// ------------------------------------------------------------------
// API
// ------------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Token': getToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
  return data;
}

const loadPosts = () => api('/api/posts');
const createPost = (post) => api('/api/posts', { method: 'POST', body: post });
const addComment = (postId, text) => api(`/api/posts/${postId}/comments`, { method: 'POST', body: { text } });
const deletePost = (postId) => api(`/api/posts/${postId}`, { method: 'DELETE' });

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
const state = {
  posts: [],
  filter: 'all', // 'all' | מפתח תחנה
  dir: 'all', // 'all' | 'to' | 'from'
  loading: false,
};

let direction = 'toG'; // toG = תחנה → גב-ים, fromG = גב-ים → תחנה
let station = STATIONS[0].key; // מפתח תחנה

const $ = (sel, root = document) => root.querySelector(sel);

const list = $('#list');
const dialog = $('#postDialog');
const postForm = $('#postForm');
const formError = $('#formError');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseYMD(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayLabel(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((parseYMD(dateStr) - today) / 86400000);
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  return new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })
    .format(parseYMD(dateStr));
}

function relTime(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'עכשיו';
  if (sec < 3600) return `לפני ${Math.floor(sec / 60)} דק׳`;
  if (sec < 86400) return `לפני ${Math.floor(sec / 3600)} שע׳`;
  return `לפני ${Math.floor(sec / 86400)} ימים`;
}

function postStation(post) {
  if (post.station && STATIONS.some((s) => s.key === post.station)) return post.station;
  const text = `${post.origin} ${post.destination}`;
  if (text.includes('הרצליה')) return 'herzliya';
  if (text.includes('רעננה מערב')) return 'raananaWest';
  if (text.includes('רעננה דרום') || text.includes('כוכב יעקב')) return 'raananaSouth';
  return null;
}

function dirBadge(post) {
  return post.direction === 'from'
    ? { text: '🏠 חוזרים מהגב-ים', cls: 'from' }
    : { text: '🏢 נוסעים אל גב-ים רעננה', cls: 'to' };
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function render() {
  const filtered = state.posts.filter((p) => {
    if (state.filter !== 'all' && postStation(p) !== state.filter) return false;
    if (state.dir !== 'all' && (p.direction === 'from' ? 'from' : 'to') !== state.dir) return false;
    return true;
  });

  if (state.loading) {
    list.innerHTML = '<div class="empty"><span class="big">⏳</span>טוען...</div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty">
        <span class="big">🚕</span>
        <span class="mission">${state.filter !== 'all' || state.dir !== 'all' ? 'אין משימות בסינון הזה' : 'MISSION START?'}</span><br>
        אין כרגע חיפושי מונית פעילים.<br>
        היו הראשונים — לחצו על <b>«מחפשים מונית»</b> ופתחו משימה חדשה!
      </div>`;
    return;
  }

  // קיבוץ לפי תאריך
  const byDate = new Map();
  for (const p of filtered) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }

  const frag = document.createDocumentFragment();
  for (const [date, posts] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const group = document.createElement('section');
    group.className = 'day-group';
    const h = document.createElement('h3');
    h.className = 'day-label';
    h.textContent = dayLabel(date);
    group.appendChild(h);

    for (const post of posts) group.appendChild(renderCard(post));
    frag.appendChild(group);
  }
  list.replaceChildren(frag);
}

function renderCard(post) {
  const tpl = $('#cardTemplate');
  const el = tpl.content.cloneNode(true);
  const card = el.querySelector('.card');
  card.dataset.id = post.id;

  const badge = el.querySelector('.dir-badge');
  const b = dirBadge(post);
  badge.textContent = b.text;
  badge.classList.add(b.cls);

  el.querySelector('.name').textContent = `${post.name} · ${relTime(post.createdAt)}`;
  el.querySelector('.route').innerHTML =
    `${esc(post.origin)} <span class="arrow">→</span> ${esc(post.destination)}`;

  const when = el.querySelector('.when');
  const flex = post.flexible ? ` <span>(<bdi>${esc(post.flexible)}</bdi>)</span>` : '';
  const stationKey = postStation(post);
  const taxi = stationKey && TAXI[stationKey]
    ? ` <span class="taxi-hint" title="הערכת נסיעה ברכב/מונית בין התחנה לגב-ים">· 🚕 ≈${TAXI[stationKey].min} דק׳</span>`
    : '';
  when.innerHTML = `⏰ <b>${esc(post.time)}</b>${flex}${taxi}`;

  const noteEl = el.querySelector('.note');
  if (post.note) {
    noteEl.hidden = false;
    noteEl.textContent = post.note;
  }

  // תגובות
  const commentsEl = el.querySelector('.comments');
  for (const c of post.comments || []) {
    const div = document.createElement('div');
    div.className = 'comment' + (c.token === getToken() ? ' mine' : '');
    div.innerHTML = `<b>${esc(c.name)}:</b> ${esc(c.text)} <span class="t">${relTime(c.createdAt)}</span>`;
    commentsEl.appendChild(div);
  }

  // תשובות מהירות
  const quick = el.querySelector('.quick');
  for (const text of ['בדרך! 🚕', 'אני שם בעוד 5 דקות ⏱', 'גם אני מצטרף/ת 👋', 'מקום פנוי? 🙋']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', () => sendComment(post.id, text));
    quick.appendChild(btn);
  }

  // טופס תגובה חופשית
  el.querySelector('.comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.querySelector('.comment-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await sendComment(post.id, text);
  });

  // מחיקה — רק לפוסטים שלי
  if (post.token === getToken()) {
    const del = el.querySelector('.del');
    del.hidden = false;
    del.addEventListener('click', async () => {
      if (!confirm('למחוק את הפרסום?')) return;
      try {
        await deletePost(post.id);
        await refresh();
      } catch (err) { alert(err.message); }
    });
  }

  return el.firstElementChild;
}

async function sendComment(postId, text) {
  try {
    await addComment(postId, text);
    await refresh();
  } catch (err) { alert(err.message); }
}

// ------------------------------------------------------------------
// לוח חי — זמני נסיעה והרכבות הבאות (מ-/api/info)
// ------------------------------------------------------------------
const DELAY_ON_TIME_MAX = 2; // עד 2 דקות איחור נחשב "בזמן"

function todayYMD() {
  return toYMD(new Date());
}

function shortDay(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((parseYMD(dateStr) - today) / 86400000);
  if (diff === 0) return '';
  if (diff === 1) return 'מחר';
  return new Intl.DateTimeFormat('he-IL', { weekday: 'short' }).format(parseYMD(dateStr));
}

function trainChip(t) {
  const chip = document.createElement('span');
  chip.className = 'tr';

  const when = document.createElement('span');
  const day = t.date && t.date !== todayYMD() ? shortDay(t.date) : '';
  when.textContent = `${day ? `${day} ` : ''}${t.time}`;
  chip.appendChild(when);

  if (t.platform) {
    const p = document.createElement('i');
    p.className = 'plat';
    p.textContent = `רצ׳ ${t.platform}`;
    chip.appendChild(p);
  }
  if (t.changes > 0) {
    const c = document.createElement('i');
    c.className = 'plat';
    c.textContent = 'החלפה';
    chip.appendChild(c);
  }

  const badge = document.createElement('em');
  if (t.cancelled) {
    badge.className = 'cancel';
    badge.textContent = 'בוטלה';
  } else {
    const delay = Number.isFinite(t.delay) ? t.delay : 0;
    if (delay > DELAY_ON_TIME_MAX) {
      badge.className = 'late';
      badge.textContent = `מאחרת ${delay}׳`;
    } else {
      badge.className = 'ok';
      badge.textContent = 'בזמן';
    }
  }
  chip.appendChild(badge);
  return chip;
}

function infoStationCard(station, meta) {
  const card = document.createElement('article');
  card.className = 'info-card';
  const h = document.createElement('h2');
  h.textContent = `🚆 ${meta.short}`;
  card.appendChild(h);

  if (station.car) {
    const taxi = document.createElement('div');
    taxi.className = 'taxi';
    taxi.textContent = `🚕 ≈${station.car.min} דק׳ נסיעה · ${station.car.km} ק״מ`;
    card.appendChild(taxi);
  }

  for (const [label, items] of [
    ['⬇️ מגיעות מת״א', station.arrivals],
    ['⬆️ יוצאות לת״א', station.departures],
  ]) {
    const line = document.createElement('div');
    line.className = 'tr-line';
    const lab = document.createElement('span');
    lab.className = 'tr-lab';
    lab.textContent = label;
    line.appendChild(lab);
    if (items.length) {
      for (const t of items) line.appendChild(trainChip(t));
    } else {
      const none = document.createElement('span');
      none.className = 'tr-none';
      none.textContent = 'אין נתונים';
      line.appendChild(none);
    }
    card.appendChild(line);
  }
  return card;
}

function renderInfo(payload) {
  const info = payload.info;
  const s = info?.stats;
  const statsEl = $('#infoStats');
  if (s && s.total) {
    const late = s.total - s.onTime;
    statsEl.textContent = `⏱️ ${s.onTime}/${s.total} רכבות בזמן` +
      (late > 0 && s.avgDelay > 0 ? ` · איחור ממוצע ${s.avgDelay} דק׳` : '');
  } else {
    statsEl.textContent = '';
  }

  const byKey = Object.fromEntries(STATIONS.map((st) => [st.key, st]));
  $('#infoGrid').replaceChildren(
    ...(info?.stations ?? []).filter((st) => byKey[st.key]).map((st) => infoStationCard(st, byKey[st.key]))
  );

  const panel = $('#infoPanel');
  panel.dataset.loaded = '1';
  panel.hidden = false;
  $('#infoUpdated').textContent =
    `עודכן ${relTime(new Date(payload.cachedAt).toISOString())}${payload.stale ? ' · מטמון' : ''}`;
}

async function refreshInfo() {
  try {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error(`info ${res.status}`);
    renderInfo(await res.json());
  } catch {
    if (!$('#infoPanel').dataset.loaded) $('#infoPanel').hidden = true;
  }
}

$('#infoToggle').addEventListener('click', () => {
  const panel = $('#infoPanel');
  const collapsed = panel.classList.toggle('collapsed');
  $('#infoToggle').textContent = collapsed ? 'הצגה ▼' : 'כיווץ ▲';
  $('#infoToggle').setAttribute('aria-expanded', String(!collapsed));
});

// ------------------------------------------------------------------
// Data refresh
// ------------------------------------------------------------------
async function refresh() {
  state.loading = state.posts.length === 0;
  render();
  try {
    const { posts } = await loadPosts();
    state.posts = posts;
    state.loading = false;
    render();
  } catch (err) {
    state.loading = false;
    list.innerHTML = `<div class="empty"><span class="big">😵</span>${esc(err.message)}<br>נסו לרענן.</div>`;
  }
}

// ------------------------------------------------------------------
// Form: segmented controls (כיוון + תחנה)
// ------------------------------------------------------------------
function updateSegmented(segRoot, attr, value) {
  for (const seg of segRoot.querySelectorAll('.seg')) {
    const active = seg.dataset[attr] === value;
    seg.classList.toggle('active', active);
    seg.setAttribute('aria-pressed', String(active));
  }
}

for (const seg of document.querySelectorAll('#directionSeg .seg')) {
  seg.addEventListener('click', () => {
    direction = seg.dataset.direction;
    updateSegmented($('#directionSeg'), 'direction', direction);
  });
}

for (const seg of document.querySelectorAll('#stationSeg .seg')) {
  seg.addEventListener('click', () => {
    station = seg.dataset.station;
    updateSegmented($('#stationSeg'), 'station', station);
  });
}

// ------------------------------------------------------------------
// Form submit
// ------------------------------------------------------------------
postForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = $('#date').value;
  const time = $('#time').value;

  formError.hidden = true;
  if (!date || !time) {
    formError.textContent = 'בחרו תאריך ושעה.';
    formError.hidden = false;
    return;
  }

  // מסלול אוטומטי לפי הכיוון: תחנה ⇄ גב-ים
  const toGavYam = direction === 'toG';
  const st = STATIONS.find((s) => s.key === station) ?? STATIONS[0];
  const origin = toGavYam ? st.full : GAV_YAM;
  const destination = toGavYam ? GAV_YAM : st.full;

  const btn = postForm.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    await createPost({
      direction: toGavYam ? 'to' : 'from',
      station: st.key,
      origin,
      destination,
      date,
      time,
      flexible: $('#flexible').value,
      note: $('#note').value.trim(),
    });
    dialog.close();
    postForm.reset();
    direction = 'toG';
    station = STATIONS[0].key;
    updateSegmented($('#directionSeg'), 'direction', direction);
    updateSegmented($('#stationSeg'), 'station', station);
    await refresh();
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------
// Wiring
// ------------------------------------------------------------------
$('#newPost').addEventListener('click', () => {
  // ברירת מחדל: היום
  const now = new Date();
  $('#date').min = toYMD(now);
  $('#date').max = toYMD(new Date(now.getTime() + 6 * 86400000));
  if (!$('#date').value) $('#date').value = toYMD(now);
  if (!$('#time').value) {
    const t = new Date(now.getTime() + 5 * 60000); // עגול ל-5 הדקות הבאות
    $('#time').value = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }
  dialog.showModal();
});

for (const btn of dialog.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => dialog.close());
}

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  for (const c of document.querySelectorAll('#filters .chip')) {
    const active = c === chip;
    c.classList.toggle('active', active);
    c.setAttribute('aria-pressed', String(active));
  }
  render();
});

$('#dirFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.dir = chip.dataset.dir;
  for (const c of document.querySelectorAll('#dirFilters .chip')) {
    const active = c === chip;
    c.classList.toggle('active', active);
    c.setAttribute('aria-pressed', String(active));
  }
  render();
});

$('#refresh').addEventListener('click', refresh);

function toYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// רענון אוטומטי כל 30 שניות וכשחוזרים ללשונית
setInterval(() => {
  if (document.visibilityState === 'visible') { refresh(); refreshInfo(); }
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refresh(); refreshInfo(); }
});

// ------------------------------------------------------------------
// PWA — service worker + כפתור התקנה
// ------------------------------------------------------------------
const isSecureCtx = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if ('serviceWorker' in navigator && isSecureCtx) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* לא קריטי */ });
}

let deferredInstall = null;
const installBtn = document.createElement('button');
installBtn.className = 'btn ghost install-btn';
installBtn.textContent = '📲 התקנה';
installBtn.title = 'התקינו את האפליקציה';
installBtn.setAttribute('aria-label', 'התקינו את האפליקציה');
installBtn.hidden = true;
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
document.querySelector('.toolbar-actions').appendChild(installBtn);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
});

refresh();
refreshInfo();
