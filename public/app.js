// app.js — לוגיקת הצד-לקוח עבור "מונית משותפת · רעננה"
'use strict';

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
  filter: 'all',
  loading: false,
};

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

const dirBadge = (d) => (d === 'to' ? '→ לרעננה' : '← מרעננה');

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function render() {
  const filtered = state.posts.filter((p) => state.filter === 'all' || p.direction === state.filter);

  if (state.loading) {
    list.innerHTML = '<div class="empty"><span class="big">⏳</span>טוען...</div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty">
        <span class="big">🚕</span>
        אין כרגע חיפושי מונית פעילים${state.filter !== 'all' ? ' בכיוון הזה' : ''}.<br>
        היו הראשונים — לחצו על <b>«מחפשים מונית»</b> ופרסמו חיפוש!
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
  badge.textContent = dirBadge(post.direction);
  badge.classList.add(post.direction);

  el.querySelector('.name').textContent = `${post.name} · ${relTime(post.createdAt)}`;
  el.querySelector('.route').innerHTML =
    `${esc(post.origin)} <span class="arrow">→</span> ${esc(post.destination)}`;

  const when = el.querySelector('.when');
  when.innerHTML = `⏰ <b>${esc(post.time)}</b>${post.flexible ? ` <span>(${esc(post.flexible)})</span>` : ''}`;

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
// Form: direction segmented control + labels
// ------------------------------------------------------------------
let direction = 'to';

function updateDirectionUI() {
  for (const seg of document.querySelectorAll('.seg')) {
    seg.classList.toggle('active', seg.dataset.direction === direction);
  }
  $('#originLabel').textContent =
    direction === 'to' ? 'מאיפה יוצאים?' : 'מאיפה ברעננה יוצאים?';
  $('#destinationLabel').textContent =
    direction === 'to' ? 'לאן נוסעים? (יעד ברעננה)' : 'לאן נוסעים?';
  $('#origin').placeholder =
    direction === 'to' ? 'לדוגמה: רעננה דרום / תחנת רכבת' : 'לדוגמה: רעננה דרום';
  $('#destination').placeholder =
    direction === 'to' ? 'לדוגמה: טריסניטיס, אזור התעשייה' : 'לדוגמה: תל אביב — אזור המסחר';
}

for (const seg of document.querySelectorAll('.seg')) {
  seg.addEventListener('click', () => {
    direction = seg.dataset.direction;
    updateDirectionUI();
  });
}

// ------------------------------------------------------------------
// Form submit
// ------------------------------------------------------------------
postForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const origin = $('#origin').value.trim();
  const destination = $('#destination').value.trim();
  const date = $('#date').value;
  const time = $('#time').value;

  formError.hidden = true;
  if (!origin || !destination) {
    formError.textContent = 'מלאו נקודת מוצא ויעד.';
    formError.hidden = false;
    return;
  }
  if (!date || !time) {
    formError.textContent = 'בחרו תאריך ושעה.';
    formError.hidden = false;
    return;
  }

  const btn = postForm.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    await createPost({
      direction,
      origin,
      destination,
      date,
      time,
      flexible: $('#flexible').value,
      note: $('#note').value.trim(),
    });
    dialog.close();
    postForm.reset();
    direction = 'to';
    updateDirectionUI();
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
    $('#time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes() + 1).padStart(2, '0')}`;
  }
  updateDirectionUI();
  dialog.showModal();
});

for (const btn of dialog.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => dialog.close());
}

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  render();
});

$('#refresh').addEventListener('click', refresh);

function toYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// רענון אוטומטי כל 30 שניות וכשחוזרים ללשונית
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
