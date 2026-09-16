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
// 🔔 צלילים — ג'ינגל "משימה הושלמה" מסונתז (בלי קבצים), עם מתג השתקה
// ------------------------------------------------------------------
const SOUND_KEY = 'st_sound';
let soundOn = localStorage.getItem(SOUND_KEY) !== '0';
let audioCtx = null;

function updateSoundBtn() {
  const b = $('#soundToggle');
  if (!b) return;
  b.textContent = soundOn ? '🔊' : '🔇';
  b.setAttribute('aria-pressed', String(soundOn));
  b.title = soundOn ? 'השתקת צלילים' : 'הפעלת צלילים';
}

function tone(freq, at, dur, type = 'square', gain = 0.1) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.start(at);
  o.stop(at + dur + 0.03);
}

function playMissionPassed() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    for (const [f, dt] of [[523.25, 0], [659.25, 0.12], [783.99, 0.24], [1046.5, 0.37]]) {
      tone(f, t + dt, 0.16);
    }
    tone(130.81, t, 0.6, 'triangle', 0.07);
  } catch { /* דפדפן בלי Web Audio — לא קריטי */ }
}

// מסך "MISSION PASSED" בסטייל GTA — עם רטט בנייד
function missionPassed() {
  const ov = document.createElement('div');
  ov.className = 'mission-passed';
  ov.innerHTML = '<div class="mp-card"><div class="mp-title">MISSION PASSED</div>' +
    '<div class="mp-sub">הפרסום עלה ללוח · RESPECT +</div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, 2300);
  function dismiss() {
    clearTimeout(timer);
    if (!ov.isConnected) return;
    ov.classList.add('out');
    setTimeout(() => ov.remove(), 320);
  }
  playMissionPassed();
  if (navigator.vibrate) navigator.vibrate([40, 50, 90]);
}

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
const state = {
  posts: [],
  filter: 'all', // 'all' | מפתח תחנה
  dir: 'to', // הכיוון שלי: 'to' | 'from' — תמיד אחד מהם (ברירת מחדל לפי שעה)
  loading: false,
  cars: null, // זמני נסיעה (עם תנועה) לפי תחנה — מגיע מ-/api/info
  info: null, // תגובת /api/info האחרונה (עבור שורת ה-hero)
  homePlan: null, // תוכנית "מתי בבית" האחרונה
  workPlan: null, // תוכנית הבוקר (מהבית לעבודה) האחרונה
  workError: false, // טעינת תוכנית הבוקר נכשלה ואין תוכנית קודמת
  homeError: false, // טעינת תוכנית הבית נכשלה ואין תוכנית קודמת
  heroSig: null, // חתימת התוכן של כרטיס ה-hero (לאנימציה רק כשמשתנה)
};

let direction = 'toG'; // toG = תחנה → גב-ים, fromG = גב-ים → תחנה
let station = STATIONS[0].key; // מפתח תחנה
let seats = 1; // מספר הנוסעים בקבוצה שלי

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

// הודעת מערכת מעוצבת (במקום alert) — role=status, נעלמת אחרי 5 שניות
function toast(message) {
  const host = $('#toastHost');
  if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, 5000);
}

function parseYMD(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// הפרש ימים מתאריך נתון עד "היום" — לפי שעון ישראל, לא לפי המכשיר
function israelDayDiff(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [ty, tm, td] = israelDatePlus(0).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

function dayLabel(dateStr) {
  const diff = israelDayDiff(dateStr);
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
    ? { text: '🏠 חוזרים הביתה', cls: 'from' }
    : { text: '🏢 נוסעים לעבודה', cls: 'to' };
}

// ברירת מחדל של הכיוון לפי השעה ביום (שעון ישראל): עד 12:00 — נוסעים לעבודה; אחרי — חוזרים הביתה
function israelHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
}

function defaultDirection() {
  return israelHour() < 12 ? 'toG' : 'fromG';
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
const seenPostIds = new Set(); // פוסטים שכבר הוצגו — לאנימציית כניסה חד-פעמית

function render() {
  updateBoardCount();
  const filtered = state.posts.filter((p) => {
    if (state.filter !== 'all' && postStation(p) !== state.filter) return false;
    return (p.direction === 'from' ? 'from' : 'to') === state.dir;
  });

  if (state.loading) {
    // שלדות טעינה באותו גובה כמו כרטיס — אין אזור ריק גם ב-reload קר
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '<div class="skeleton-card" aria-hidden="true"></div><div class="skeleton-card" aria-hidden="true"></div>';
    return;
  }
  list.removeAttribute('aria-busy');

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty">
        <span class="big" aria-hidden="true">🚕</span>
        <span class="mission">${state.filter !== 'all' ? 'אין משימות בסינון הזה' : 'MISSION START?'}</span>
        <p class="state-text">אין כרגע חיפושי מונית ${state.dir === 'from' ? 'לכיוון הביתה' : 'לגב-ים'}.<br>
        היו הראשונים — לחצו על <b>«מחפשים מונית»</b>!</p>
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
    const h = document.createElement('h2');
    h.className = 'day-label';
    h.textContent = dayLabel(date);
    group.appendChild(h);

    for (const [i, post] of posts.entries()) group.appendChild(renderCard(post, i));
    frag.appendChild(group);
  }
  list.replaceChildren(frag);
}

// מונה חי מעל הלוח — מתעדכן באנימציה כשמספר המחפשים משתנה
function updateBoardCount() {
  // סקופ הכיוון שלי גלוי תמיד ליד הסינון (הלוח מסונן לפיו)
  const scope = $('#boardScope');
  if (scope) {
    const scopeText = `הכיוון שלי: ${state.dir === 'from' ? 'הביתה' : 'לעבודה'}`;
    if (scope.textContent !== scopeText) scope.textContent = scopeText; // לא להקריא שוב ושוב לקורא מסך
  }
  const el = $('#boardCount');
  if (!el) return;
  const total = state.posts.length;
  const mine = state.posts.filter((p) => (p.direction === 'from' ? 'from' : 'to') === state.dir).length;
  if (!total) { el.hidden = true; el.dataset.sig = ''; return; }
  el.hidden = false;
  const sig = `${total}/${mine}`;
  if (el.dataset.sig === sig) return;
  const grew = el.dataset.sig && Number(el.dataset.sig.split('/')[0]) < total;
  el.dataset.sig = sig;
  el.textContent = `📣 ${total} מחפשים בלוח · ${mine} בכיוון שלך${grew ? ' · מצטרפים! 🔥' : ''}`;
  el.classList.remove('pop');
  void el.offsetWidth; // restart animation
  el.classList.add('pop');
}

function renderCard(post, index = 0) {
  const tpl = $('#cardTemplate');
  const el = tpl.content.cloneNode(true);
  const card = el.querySelector('.card');
  card.dataset.id = post.id;
  card.style.setProperty('--i', String(index));
  // אנימציית כניסה רק בפעם הראשונה שהכרטיס מופיע (לא בכל רענון של 30 שנ׳)
  if (!seenPostIds.has(post.id)) {
    seenPostIds.add(post.id);
    card.classList.add('enter');
  }

  const badge = el.querySelector('.dir-badge');
  const b = dirBadge(post);
  badge.textContent = b.text;
  badge.classList.add(b.cls);

  el.querySelector('.name').textContent = `${post.name} · ${relTime(post.createdAt)}`;
  if (post.seats > 1) {
    const seatsChip = el.querySelector('.seats-chip');
    seatsChip.hidden = false;
    seatsChip.textContent = `👥 ${post.seats} נוסעים`;
    seatsChip.title = `הקבוצה שלי: ${post.seats} נוסעים`;
  }
  el.querySelector('.route').innerHTML =
    `${esc(post.origin)} <span class="arrow">←</span> ${esc(post.destination)}`;

  const when = el.querySelector('.when');
  const flex = post.flexible ? ` <span>(<bdi>${esc(post.flexible)}</bdi>)</span>` : '';
  const stationKey = postStation(post);
  const car = stationKey ? (state.cars?.[stationKey] ?? TAXI[stationKey]) : null;
  const fare = fareEstimate(car);
  const taxi = car
    ? ` <span class="taxi-hint" data-key="${esc(stationKey)}" title="${fare ? `הערכת מונית שלמה ≈${fare.total} ₪ · משותפת ל-3 ≈${fare.per3} ₪ לאדם` : 'זמן נסיעה משוער ברכב/מונית'}">· 🚕 ≈${car.min} דק׳${fare ? ` · ≈${fare.total} ₪` : ''}</span>`
    : '';
  when.innerHTML = `<b><bdi>${esc(post.time)}</bdi></b>${flex}${taxi}`;

  const noteEl = el.querySelector('.note');
  if (post.note) {
    noteEl.hidden = false;
    noteEl.textContent = post.note;
  }

  // תגובות
  const commentsEl = el.querySelector('.comments');
  for (const c of post.comments || []) {
    const mine = c.token === getToken();
    const div = document.createElement('div');
    div.className = 'comment' + (mine ? ' mine' : '');
    div.innerHTML = `<b>${esc(c.name)}${mine ? ' (אני)' : ''}:</b> ${esc(c.text)} <span class="t">${relTime(c.createdAt)}</span>`;
    commentsEl.appendChild(div);
  }

  // תשובות מהירות — אמוג׳י ראשון בתווית (עקביות עם הצ׳יפים)
  const quick = el.querySelector('.quick');
  for (const [emoji, text] of [
    ['🚕', 'בדרך!'],
    ['⏱', 'אני שם בעוד 5 דקות'],
    ['👋', 'גם אני מצטרף/ת'],
    ['🙋', 'מקום פנוי?'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.append(emojiSpan(emoji), ` ${text}`);
    btn.addEventListener('click', () => sendComment(post.id, `${emoji} ${text}`));
    quick.appendChild(btn);
  }

  // שיתוף ההזמנה — פעולה נפרדת עם קו מפריד לפניה (לא עוד תגובה מהירה)
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'share-btn';
  shareBtn.append(emojiSpan('📤'), ' שתפו');
  shareBtn.title = 'שיתוף ההזמנה עם נוסעים';
  shareBtn.addEventListener('click', () => sharePost(post));
  el.querySelector('.share-row').appendChild(shareBtn);

  // טופס תגובה חופשית — כפתור השליחה מושבת כשאין טקסט
  const commentForm = el.querySelector('.comment-form');
  const commentInput = commentForm.querySelector('.comment-input');
  const commentSend = commentForm.querySelector('button[type="submit"]');
  const syncSend = () => {
    commentSend.disabled = !commentInput.value.trim();
    commentSend.title = commentSend.disabled ? 'כתבו הודעה כדי לשלוח' : '';
  };
  commentInput.addEventListener('input', syncSend);
  syncSend();
  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = commentInput.value.trim();
    if (!text) return;
    commentInput.value = '';
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
      } catch (err) { toast(err.message); }
    });
  }

  return el.firstElementChild;
}

/** אומדן מונית (נסיעה שלמה + חלוקה) מתוך ק"מ */
function fareEstimate(car) {
  if (!car || !Number.isFinite(car.km) || car.km <= 0) return null;
  const total = Math.round(12.5 + car.km * 3.2);
  return { total, per3: Math.max(1, Math.round(total / 3)) };
}

function updateTaxiHints() {
  for (const el of document.querySelectorAll('.taxi-hint[data-key]')) {
    const car = state.cars?.[el.dataset.key] ?? TAXI[el.dataset.key];
    if (!car) continue;
    const fare = fareEstimate(car);
    el.textContent = `· 🚕 ≈${car.min} דק׳` + (fare ? ` · ≈${fare.total} ₪` : '');
    if (fare) el.title = `הערכת מונית שלמה ≈${fare.total} ₪ · משותפת ל-3 ≈${fare.per3} ₪ לאדם`;
  }
}

// שיתוף הזמנה — שיתוף מקורי במכשיר, וואטסאפ כברירת מחדל
async function sharePost(post) {
  const dir = post.direction === 'from' ? '🏠 חוזרים הביתה' : '🏢 נוסעים לגב-ים';
  const when = `${dayLabel(post.date)} ${post.time}${post.flexible ? ` (${post.flexible})` : ''}`;
  const lines = [
    '🚕 מונית משותפת · גב-ים רעננה',
    `${dir} · ${post.origin} ← ${post.destination}`,
    `⏰ ${when}`,
  ];
  if (post.note) lines.push(`📌 ${post.note}`);
  if (post.seats > 1) lines.push(`👥 ${post.seats} נוסעים`);
  lines.push('', location.origin + location.pathname);
  const text = lines.join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: 'מונית משותפת · גב-ים רעננה', text }); } catch { /* המשתמש ביטל */ }
    return;
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

async function sendComment(postId, text) {
  try {
    await addComment(postId, text);
    await refresh();
  } catch (err) { toast(err.message); }
}

// ------------------------------------------------------------------
// לוח חי — זמני נסיעה והרכבות הבאות (מ-/api/info)
// ------------------------------------------------------------------
const DELAY_ON_TIME_MAX = 2; // עד 2 דקות איחור נחשב "בזמן"

function todayYMD() {
  return israelDatePlus(0);
}

function shortDay(dateStr) {
  const diff = israelDayDiff(dateStr);
  if (diff === 0) return '';
  if (diff === 1) return 'מחר';
  return new Intl.DateTimeFormat('he-IL', { weekday: 'short' }).format(parseYMD(dateStr));
}

function emojiSpan(char) {
  const s = document.createElement('span');
  s.className = 'emoji';
  s.setAttribute('aria-hidden', 'true');
  s.textContent = char;
  return s;
}

function trainTime(t, primary = false, rowDate = null) {
  const wrap = document.createElement('span');
  wrap.className = 'ir-time-wrap';

  // תגית יום לכל זמן שאינו היום (ולא חוזרת על תגית היום של השורה)
  if (t.date && t.date !== todayYMD() && t.date !== rowDate) {
    const day = document.createElement('i');
    day.className = 'ir-day-tag';
    day.textContent = shortDay(t.date);
    wrap.appendChild(day);
  }

  const el = document.createElement('bdi');
  el.className = 'ir-time' + (primary ? ' primary' : '');
  el.textContent = t.time;
  if (t.cancelled) el.classList.add('cancel');
  else if (Number.isFinite(t.delay) && t.delay > DELAY_ON_TIME_MAX) el.classList.add('late');
  wrap.appendChild(el);

  if (t.cancelled) {
    const tag = document.createElement('i');
    tag.className = 'ir-tag cancel';
    tag.textContent = 'בוטל';
    wrap.appendChild(tag);
  } else if (Number.isFinite(t.delay) && t.delay > DELAY_ON_TIME_MAX) {
    const tag = document.createElement('i');
    tag.className = 'ir-tag late';
    tag.textContent = `+${t.delay}׳`;
    wrap.appendChild(tag);
  }
  if (t.platform) {
    const p = document.createElement('i');
    p.className = 'ir-plat';
    p.textContent = `רצ׳ ${t.platform}`;
    wrap.appendChild(p);
  }
  if (primary && !t.cancelled) {
    const mins = minsUntil(t.date, t.time);
    if (mins != null && mins <= 180) {
      const cd = document.createElement('i');
      cd.className = 'ir-cd' + (mins <= 7 ? ' soon' : '');
      cd.textContent = mins <= 1 ? 'עכשיו' : `בעוד ${mins}׳`;
      wrap.appendChild(cd);
    }
  }
  return wrap;
}

function infoStationRow(station, meta) {
  const row = document.createElement('article');
  row.className = 'info-row';

  const top = document.createElement('span');
  top.className = 'ir-top';

  const name = document.createElement('span');
  name.className = 'ir-name';
  name.append(emojiSpan('🚆'), ` ${meta.short}`);
  top.appendChild(name);

  if (station.car) {
    const taxi = document.createElement('span');
    taxi.className = 'ir-taxi';
    taxi.append(emojiSpan('🚕'), ` ${station.car.min}׳`);
    taxi.title = `≈${station.car.min} דק׳ נסיעה · ${station.car.km} ק״מ` + (station.car.live ? ' · זמן אמת' : ' · הערכה');
    top.appendChild(taxi);
  }

  const first = [...station.arrivals, ...station.departures][0];
  if (first && first.date && first.date !== todayYMD()) {
    const day = document.createElement('span');
    day.className = 'ir-day';
    day.textContent = shortDay(first.date);
    top.appendChild(day);
  }
  row.appendChild(top);

  const times = document.createElement('span');
  times.className = 'ir-times';
  for (const [label, items] of [['מגיעות', station.arrivals], ['יוצאות', station.departures]]) {
    const group = document.createElement('span');
    group.className = 'ir-group';
    group.title = `${label} ${label === 'מגיעות' ? 'לתחנה' : 'מהתחנה'}`;
    const dir = document.createElement('span');
    dir.className = 'ir-dir';
    dir.textContent = label;
    group.appendChild(dir);
    if (!items.length) {
      const none = document.createElement('span');
      none.className = 'ir-none';
      none.textContent = '—';
      group.appendChild(none);
    } else {
      items.forEach((t, i) => {
        if (i) {
          const sep = document.createElement('span');
          sep.className = 'ir-sep';
          sep.textContent = '·';
          group.appendChild(sep);
        }
        group.appendChild(trainTime(t, i === 0, first?.date ?? null));
      });
    }
    times.appendChild(group);
  }
  row.appendChild(times);
  return row;
}

function renderInfo(payload) {
  const info = payload.info;
  const s = info?.stats;
  const statsEl = $('#infoStats');
  if (s && s.total) {
    const late = s.total - s.onTime;
    statsEl.textContent = `⏱️ ${s.onTime}/${s.total} רכבות בזמן` +
      (late > 0 && s.avgDelay > 0 ? ` · איחור ממוצע ${s.avgDelay} דק׳` : '');
    statsEl.classList.toggle('warn', s.onTime / s.total < 0.7);
  } else {
    statsEl.textContent = '';
    statsEl.classList.remove('warn');
  }

  state.cars = Object.fromEntries(
    (info?.stations ?? []).filter((st) => st.car).map((st) => [st.key, st.car])
  );
  updateTaxiHints();

  const byKey = Object.fromEntries(STATIONS.map((st) => [st.key, st]));
  $('#infoGrid').replaceChildren(
    ...(info?.stations ?? []).filter((st) => byKey[st.key]).map((st) => infoStationRow(st, byKey[st.key]))
  );

  const panel = $('#infoPanel');
  panel.dataset.loaded = '1';
  panel.hidden = false;
  panel.classList.remove('loading');
  if (!panel.dataset.toggled) setPanelCollapsed(!!home);
  const ageMin = Math.round((Date.now() - payload.cachedAt) / 60000);
  const stale = payload.stale || ageMin >= 5;
  // רצועת אזהרה בראש הכרטיס כשהנתונים מיושנים (במקום רק צבע בתחתית)
  const staleEl = $('#infoStale');
  if (stale) {
    staleEl.hidden = false;
    const staleText = `⚠️ הנתונים בני ${Math.max(1, ageMin)} דק׳ — מרעננים…`;
    if (staleEl.textContent !== staleText) staleEl.textContent = staleText;
  } else {
    staleEl.hidden = true;
  }
  const foot = $('#infoUpdated');
  foot.textContent = `עודכן ${relTime(new Date(payload.cachedAt).toISOString())}${stale ? ' · ייתכן שאינו מעודכן' : ''}`;

  state.info = info;
  renderHero();
}

async function refreshInfo() {
  refreshHomePlan(); // במקביל — לא תלוי בהצלחת לוח הרכבות
  refreshWorkPlan();
  const panel = $('#infoPanel');
  // שלד טעינה — הלוח מוצג מיד עם אנימציית shimmer במקום מסך ריק
  if (!panel.dataset.loaded) {
    panel.hidden = false;
    panel.classList.add('loading');
    if (!$('#infoGrid').childElementCount) {
      $('#infoGrid').innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
    }
  }
  try {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error(`info ${res.status}`);
    renderInfo(await res.json());
    return true;
  } catch {
    panel.classList.remove('loading');
    if (!panel.dataset.loaded) panel.hidden = true;
    return false;
  }
}

// ------------------------------------------------------------------
// "הכיוון שלי" + שורת ה-hero: מה הצעד הבא שלי
// ------------------------------------------------------------------
function stationShort(key) {
  return STATIONS.find((s) => s.key === key)?.short ?? key;
}

function setDirection(dir) {
  state.dir = dir === 'from' ? 'from' : 'to';
  for (const seg of document.querySelectorAll('#myDirSeg .seg')) {
    const active = (seg.dataset.direction === 'toG' ? 'to' : 'from') === state.dir;
    seg.classList.toggle('active', active);
    seg.setAttribute('aria-pressed', String(active));
  }
  $('#myDirSeg').dataset.dir = state.dir;
  if (typeof syncPushPrefs === 'function') syncPushPrefs();
  renderHero();
  render();
}

function heroEl(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}
const big = (html) => heroEl('hero-big', html);
const doLine = (html) => heroEl('hero-do', html);
const detail = (text) => { const d = heroEl('hero-detail'); d.textContent = text; return d; };
const altLine = (text) => { const d = heroEl('hero-alts'); d.textContent = text; return d; };

function transferText(t) {
  const name = (t.stationName ?? '').split(' - ')[0];
  const parts = [];
  if (t.arrivePlatform) parts.push(`יורדים ברציף ${t.arrivePlatform}`);
  if (t.departPlatform) parts.push(`עולים ברציף ${t.departPlatform}`);
  if (Number.isFinite(t.waitMin)) parts.push(`המתנה ${t.waitMin} דק׳`);
  // שעת ההחלפה עשויה להיות מחר — תווית יום מפורשת (מטמון ישן בלי departDate לא נשבר)
  const depDay = t.departDate && t.departDate !== todayYMD() ? `${shortDay(t.departDate)} ` : '';
  return `החלפה ב${name || 'תחנת מעבר'}` +
    (parts.length ? ` · ${parts.join(' · ')}` : '') +
    (t.departTime ? ` · הרכבת ב-${depDay}${t.departTime}` : '') +
    (t.towards ? ` · לכיוון ${t.towards}` : '');
}

// כל ההחלפות של אפשרות (תאימות גם למטמון ישן עם transfer בודד)
function transfersOf(o) {
  if (Array.isArray(o.transfers)) return o.transfers;
  return o.transfer ? [o.transfer] : [];
}

// ספירה לאחור לזמן מפתח (לפי שעון ישראל) — מוצגת רק עד 3 שעות לפני
function israelOffsetMs(epochMs) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function minsUntil(dateStr, hhmm) {
  if (!dateStr || !hhmm) return null;
  const guess = Date.parse(`${dateStr}T${hhmm}:00Z`);
  if (!Number.isFinite(guess)) return null;
  const epoch = guess - israelOffsetMs(guess);
  return Math.round((epoch - Date.now()) / 60000);
}

function countdownEl(dateStr, hhmm) {
  const mins = minsUntil(dateStr, hhmm);
  if (mins == null || mins > 180) return null;
  const span = document.createElement('span');
  span.className = 'hero-cd';
  span.dataset.date = dateStr;
  span.dataset.time = hhmm;
  span.textContent = mins <= 1 ? 'עכשיו' : `בעוד ${mins} דק׳`;
  if (mins <= 7) span.classList.add('soon');
  return span;
}

function updateCountdowns() {
  for (const el of document.querySelectorAll('.hero-cd')) {
    const mins = minsUntil(el.dataset.date, el.dataset.time);
    if (mins == null || mins > 180) { el.remove(); continue; }
    el.textContent = mins <= 1 ? 'עכשיו' : `בעוד ${mins} דק׳`;
    el.classList.toggle('soon', mins <= 7);
  }
}

// תגית יום ("מחר" / יום בשבוע) לזמן שאינו היום — לא משנים את המחרוזת כשהיום זהה
function dayLabelHtml(dateStr) {
  return dateStr && dateStr !== todayYMD()
    ? `<span class="hero-day">${shortDay(dateStr)}</span> `
    : '';
}

function heroChip(text) {
  const s = document.createElement('span');
  s.className = 'hero-chip';
  s.textContent = text;
  return s;
}

// החלפות כצ׳יפים נפרדים (במקום משפט רץ עם מפרידים) — כל שעת המשך מקבלת תגית יום
function transferChips(o) {
  const transfers = transfersOf(o);
  if (!transfers.length) return null;
  const wrapEl = heroEl('hero-chips');
  for (const t of transfers) {
    const name = (t.stationName ?? '').split(' - ')[0];
    if (name) wrapEl.appendChild(heroChip(`החלפה ב${name}`));
    if (t.arrivePlatform && t.departPlatform) {
      wrapEl.appendChild(heroChip(`רציף ${t.arrivePlatform}→${t.departPlatform}`));
    } else if (t.departPlatform) {
      wrapEl.appendChild(heroChip(`רציף ${t.departPlatform}`));
    }
    if (Number.isFinite(t.waitMin)) wrapEl.appendChild(heroChip(`המתנה ${t.waitMin} דק׳`));
    if (t.departTime) {
      const depDay = t.departDate && t.departDate !== todayYMD() ? `${shortDay(t.departDate)} ` : '';
      wrapEl.appendChild(heroChip(`רכבת המשך ${depDay}${t.departTime}`));
    }
  }
  wrapEl.title = transfers.map((t) => transferText(t)).join(' | ');
  return wrapEl;
}

// בלוק אפשרות חלופית (תחנה אחרת) — כל זמן שאינו היום מסומן בתגית יום
function optBlockFor(r, dir) {
  const o = r.o;
  const wrapEl = heroEl('hero-opt');
  const main = heroEl('hero-opt-main');
  main.textContent = `או דרך ${stationShort(r.key)}`;
  wrapEl.appendChild(main);
  const sub = heroEl('hero-opt-sub');
  const carDay = r.car?.min ? ` · 🚕 ≈${r.car.min} דק׳` : '';
  const fareTxt = Number.isFinite(r.fare) ? `≈₪${r.fare} · ` : '';
  if (dir === 'to') {
    sub.textContent = fareTxt + `רכבת ${(o.depDate && o.depDate !== todayYMD()) ? `${shortDay(o.depDate)} ` : ''}${o.depHome}` +
      ` ← בגב-ים ${(o.arriveGavDate && o.arriveGavDate !== todayYMD()) ? `${shortDay(o.arriveGavDate)} ` : ''}${o.arriveGav}` +
      carDay;
  } else {
    sub.textContent = fareTxt + `רכבת ${(o.departDate && o.departDate !== todayYMD()) ? `${shortDay(o.departDate)} ` : ''}${o.trainDeparture}` +
      ` ← בבית ${(o.arriveDate && o.arriveDate !== todayYMD()) ? `${shortDay(o.arriveDate)} ` : ''}${o.arriveHome}` +
      ` (צאו עד ${o.leaveBy})`;
  }
  wrapEl.appendChild(sub);
  const chips = transferChips(o);
  if (chips) wrapEl.appendChild(chips);
  return wrapEl;
}

// חלופות מקופלות כברירת מחדל — disclosure עם aria-expanded מובנה
function moreBlock(children, count) {
  if (!children.length) return null;
  const det = document.createElement('details');
  det.className = 'hero-more';
  const sum = document.createElement('summary');
  sum.textContent = count > 0 ? `עוד ${count} אפשרויות` : 'עוד אפשרויות';
  const body = heroEl('hero-more-body');
  for (const c of children) body.appendChild(c);
  det.append(sum, body);
  return det;
}

// חתימת תוכן לאפשרות — לאנימציה רק כשמשהו משתנה (כולל תאריכי יום לכל זמן)
function oSig(o) {
  return [
    o.depHome ?? o.trainDeparture ?? '', o.depDate ?? o.departDate ?? '',
    o.arriveStation ?? o.arriveHome ?? '', o.arriveDate ?? o.arriveStationDate ?? '',
    o.arriveGav ?? '', o.arriveGavDate ?? '', o.leaveBy ?? '', o.leaveByDate ?? '', o.boardPlatform ?? '',
    transfersOf(o).map((t) => `${t.stationId}:${t.arrivePlatform}:${t.departPlatform}:${t.departDate}:${t.departTime}:${t.waitMin}`).join('+'),
  ].join('|');
}

// ------------------------------------------------------------------
// העדפה: 💰 זול (ברירת מחדל) / ⚡ מהיר — נשמרת מקומית
// ------------------------------------------------------------------
const PREF_KEY = 'st_pref';
let pref = localStorage.getItem(PREF_KEY) === 'fast' ? 'fast' : 'cheap';

// דירוג האפשרויות לפי ההעדפה (PlanningCore) עם מחיר מונית לכל תחנה
function rankPlan(plan) {
  const cands = (plan?.stations ?? [])
    .filter((s) => s.options?.length)
    .map((s) => ({
      key: s.key,
      car: s.car,
      o: s.options[0],
      fare: fareEstimate(s.car)?.total ?? null,
      changes: s.options[0].changes ?? 0,
    }));
  return PlanningCore.rankOptions(cands, pref);
}

// דירוג עם נפילה בטוחה לתוכנית קיימת (אם אין מספיק נתונים לדירוג)
function rankOrBest(plan) {
  const ranked = rankPlan(plan);
  if (ranked) return ranked;
  const best = plan?.best;
  if (!best) return null;
  const car = plan.stations?.find((s) => s.key === best.stationKey)?.car ?? null;
  return {
    chosen: { key: best.stationKey, car, o: best, fare: fareEstimate(car)?.total ?? null },
    fastest: null, cheapest: null, others: [], pref, savings: null, delayMin: 0,
  };
}

// תג הסבר להמלצה — כדי שברור למה זו נבחרה
function whyEl(ranked) {
  if (!ranked || !ranked.chosen) return null;
  const s = document.createElement('span');
  s.className = 'hero-why';
  if (ranked.chosen.key === ranked.fastest.key) {
    const cheaperLater = ranked.cheapest && ranked.cheapest.key !== ranked.chosen.key;
    s.textContent = ranked.pref === 'cheap' && cheaperLater
      ? `⚡ מהיר · הזול מאחר ב-${Math.max(1, Math.round((ranked.cheapest.arrival - ranked.chosen.arrival) / 60000))} דק׳`
      : '⚡ הכי מהיר';
  } else {
    s.textContent = '💰 הזול מבין המהירים' + (ranked.savings >= 5 ? ` · חוסך ≈₪${ranked.savings}` : '');
  }
  return s;
}

// ------------------------------------------------------------------
// בדרך — מצב מסע: נועל את המסלול, מציג התקדמות, ומזהה מיקום (אופציונלי)
// ------------------------------------------------------------------
const JOURNEY_KEY = 'st_journey';
const STATION_IDS = { raananaWest: 2940, raananaSouth: 2960, herzliya: 3500 };
const GAV_YAM_COORD = { lat: 32.1942096, lon: 34.8824513 };
let journey = null;
try { journey = JSON.parse(localStorage.getItem(JOURNEY_KEY) || 'null'); } catch { journey = null; }
if (!journey || !Array.isArray(journey.steps) || !journey.steps.length) journey = null;
let coordCache = null;
let geoPermitted = false;

if (navigator.permissions?.query) {
  navigator.permissions.query({ name: 'geolocation' })
    .then((p) => {
      geoPermitted = p.state === 'granted';
      p.onchange = () => { geoPermitted = p.state === 'granted'; };
    })
    .catch(() => { /* לא נתמך */ });
}

async function loadCoords() {
  if (coordCache) return coordCache;
  try {
    const { stations } = await fetch('/api/stations').then((r) => r.json());
    coordCache = Object.fromEntries(
      (stations ?? []).filter((s) => Number.isFinite(s.lat))
        .map((s) => [s.id, { lat: s.lat, lon: s.lon }])
    );
  } catch { coordCache = {}; }
  return coordCache;
}

function saveJourney() {
  try { localStorage.setItem(JOURNEY_KEY, JSON.stringify(journey)); } catch { /* לא קריטי */ }
}

function clearJourney() {
  journey = null;
  try { localStorage.removeItem(JOURNEY_KEY); } catch { /* לא קריטי */ }
  state.heroSig = null;
  renderHero();
}

async function startJourney(ranked, dir) {
  if (!ranked?.chosen) return;
  const o = ranked.chosen.o;
  const st = STATIONS.find((s) => s.key === o.stationKey);
  const coords = await loadCoords();
  const coordMap = { gav: GAV_YAM_COORD };
  if (home?.id && coords[home.id]) coordMap[home.id] = coords[home.id];
  const taxiId = o.stationKey ? STATION_IDS[o.stationKey] : null;
  if (taxiId && coords[taxiId]) coordMap[taxiId] = coords[taxiId];
  for (const t of transfersOf(o)) {
    if (t.stationId && coords[t.stationId]) coordMap[t.stationId] = coords[t.stationId];
  }
  journey = {
    id: String(Date.now().toString(36)),
    dir,
    homeName: home?.name ?? '',
    homeId: home?.id ?? null,
    steps: PlanningCore.buildJourney(o, dir, {
      homeName: home?.name ?? '',
      homeId: home?.id ?? null,
      taxiStationName: st?.full ?? o.stationKey,
      taxiStationKey: o.stationKey,
      carMin: ranked.chosen.car?.min ?? 12,
    }),
    coordMap,
    doneThrough: -1,
    startedAt: Date.now(),
  };
  saveJourney();
  state.heroSig = null;
  renderHero();
  toast('🚕 יוצאים לדרך — המסלול נעול');
}

function journeyTargetCoord(step) {
  const cm = journey?.coordMap ?? {};
  if (step.toId && cm[step.toId]) return cm[step.toId];
  if (step.toKey) {
    const id = STATION_IDS[step.toKey];
    if (id && cm[id]) return cm[id];
  }
  if (step.toName === GAV_YAM) return cm.gav;
  return null;
}

function advanceJourney(stepIndex) {
  if (!journey) return;
  journey.doneThrough = Math.max(journey.doneThrough, stepIndex);
  saveJourney();
  state.heroSig = null;
  renderHero();
}

function checkJourneyLocation(manual = false) {
  if (!journey || !navigator.geolocation) {
    if (manual) toast('הדפדפן לא תומך במיקום');
    return;
  }
  const st = PlanningCore.journeyState(journey.steps, Date.now(), journey.doneThrough);
  const idx = st.states.findIndex((s) => s !== 'done');
  if (idx < 0) return;
  const step = journey.steps[idx];
  const target = journeyTargetCoord(step);
  if (!target) { if (manual) toast('אין מיקום ידוע לתחנת היעד'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      geoPermitted = true;
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      const d = PlanningCore.distanceM(here, target);
      if (d <= 450) {
        advanceJourney(idx);
        toast(`📍 הגעת ל${step.toName}`);
      } else if (manual) {
        toast(`📍 במרחק ≈${(d / 1000).toFixed(1)} ק״מ מ${step.toName}`);
      }
    },
    (err) => {
      if (manual) toast(err?.code === 1 ? 'אין הרשאת מיקום — אפשר לאשר בדפדפן' : 'לא הצלחנו לקבל מיקום');
    },
    { timeout: 8000, maximumAge: 60000 }
  );
}

// בדיקת מיקום כל 60 שנ׳ כשהמסך גלוי (רק אם ההרשאה כבר אושרה)
setInterval(() => {
  if (!journey || document.visibilityState !== 'visible' || !geoPermitted) return;
  checkJourneyLocation(false);
}, 60000);

// ניקוי אוטומטי אחרי זמן ההגעה
setInterval(() => {
  if (!journey) return;
  const st = PlanningCore.journeyState(journey.steps, Date.now(), journey.doneThrough);
  if (Number.isFinite(st.finishAt) && Date.now() > st.finishAt + 45 * 60000) {
    clearJourney();
    toast('✅ הנסיעה הסתיימה');
  }
}, 60000);

// תצוגת מסע יציבה (לא מתעדכנת עם הזמן מלבד ספירה לאחור/מצבים)
function journeyRender() {
  if (!journey) return null;
  const st = PlanningCore.journeyState(journey.steps, Date.now(), journey.doneThrough);
  const finalStep = journey.steps[journey.steps.length - 1];
  const finalIso = finalStep?.arriveAt ?? '';
  const finalTime = finalIso.slice(11, 16);
  const finalDay = finalIso.slice(0, 10) !== todayYMD() ? shortDay(finalIso.slice(0, 10)) : '';
  const sig = `journey/${journey.id}/${journey.doneThrough}/${st.states.join(',')}/${Math.floor(Date.now() / 60000)}`;

  const render = () => {
    const el0 = $('#heroLine');
    el0.appendChild(heroEl('hero-eyebrow',
      journey.dir === 'from' ? '🏠 בדרך הביתה · המסלול נעול' : '🏢 בדרך לעבודה · המסלול נעול'));

    const bigEl = big(
      `${journey.dir === 'from' ? '🏠 בבית' : '🏢 בגב-ים'} ` +
      `<span class="hero-time"><bdi>${finalTime}</bdi></span> ` +
      (finalDay ? `<span class="hero-day">${finalDay}</span>` : '')
    );
    if (st.next && Number.isFinite(st.next.at)) {
      const mins = Math.round((st.next.at - Date.now()) / 60000);
      if (mins >= 0 && mins <= 180) {
        const cd = document.createElement('span');
        cd.className = 'hero-cd' + (mins <= 7 ? ' soon' : '');
        cd.textContent = mins <= 1 ? 'עכשיו' : `בעוד ${mins} דק׳`;
        bigEl.appendChild(cd);
      }
    }
    el0.appendChild(bigEl);

    const tl = document.createElement('div');
    tl.className = 'journey';
    journey.steps.forEach((s, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'j-step ' + st.states[i];
      const dot = document.createElement('span');
      dot.className = 'j-dot';
      dot.textContent = st.states[i] === 'done' ? '✅' : st.states[i] === 'current' ? '👉' : '⏳';
      rowEl.appendChild(dot);
      const body = document.createElement('div');
      const main = document.createElement('div');
      main.className = 'j-main';
      main.textContent = s.kind === 'train'
        ? `🚆 רכבת ${s.train ?? ''} · ${s.fromName} ← ${s.toName}`
        : `🚕 מונית · ${s.fromName} ← ${s.toName}`;
      body.appendChild(main);
      const sub = document.createElement('div');
      sub.className = 'j-sub';
      const bits = [];
      const depT = (s.departAt ?? '').slice(11, 16);
      const arrT = (s.arriveAt ?? '').slice(11, 16);
      if (depT) bits.push(depT);
      if (arrT) bits.push(arrT);
      if (s.platform) bits.push(`רציף ${s.platform}`);
      if (s.towards) bits.push(`לכיוון ${s.towards}`);
      sub.textContent = bits.join(' · ');
      body.appendChild(sub);
      rowEl.appendChild(body);
      tl.appendChild(rowEl);
    });
    el0.appendChild(tl);

    const actions = document.createElement('div');
    actions.className = 'j-actions';
    if (navigator.geolocation) {
      const locBtn = document.createElement('button');
      locBtn.type = 'button';
      locBtn.className = 'btn ghost sm';
      locBtn.textContent = '📍 עדכון מיקום';
      locBtn.addEventListener('click', () => checkJourneyLocation(true));
      actions.appendChild(locBtn);
    }
    const nextIdx = st.states.findIndex((s) => s !== 'done');
    if (nextIdx >= 0) {
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn ghost sm';
      nextBtn.textContent = '⏭ הבא';
      nextBtn.addEventListener('click', () => advanceJourney(nextIdx));
      actions.appendChild(nextBtn);
    }
    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'btn ghost sm';
    endBtn.textContent = 'סיים נסיעה';
    endBtn.addEventListener('click', () => clearJourney());
    actions.appendChild(endBtn);
    el0.appendChild(actions);
  };
  return { sig, render };
}

// בורר העדפה קטן בתוך כרטיס הפנים
function prefRow() {
  const wrap = document.createElement('div');
  wrap.className = 'hero-pref';
  const lab = document.createElement('span');
  lab.className = 'hero-pref-label';
  lab.textContent = 'העדפה:';
  wrap.appendChild(lab);
  for (const [val, text] of [['cheap', '💰 זול'], ['fast', '⚡ מהיר']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pref-chip' + (pref === val ? ' on' : '');
    b.textContent = text;
    b.setAttribute('aria-pressed', String(pref === val));
    b.addEventListener('click', () => {
      if (pref === val) return;
      pref = val;
      try { localStorage.setItem(PREF_KEY, pref); } catch { /* לא קריטי */ }
      state.heroSig = null;
      renderHero();
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function renderHero() {
  const el = $('#heroLine');
  updateCountdowns();
  let sig;
  let render;
  let hasData = false;

  const jr = journeyRender();
  if (jr) {
    sig = jr.sig;
    render = jr.render;
    hasData = true;
  } else if (state.dir === 'to') {
    if (!home) {
      sig = 'to/nohome';
      render = () => { el.textContent = '🏠 לחצו כאן לבחירת תחנת הבית — ונחשב את הדרך מהבית לעבודה'; };
    } else if (!state.workPlan) {
      sig = state.workError ? 'to/error' : 'to/loading';
      render = () => { el.textContent = state.workError
        ? '⚠️ לא הצלחנו לטעון את הדרך מהבית — ננסה שוב ברענון הקרוב'
        : '🚆 מחשבים את הדרך מהבית…'; };
    } else if (!state.workPlan.best) {
      sig = 'to/none';
      render = () => { el.textContent = '🚆 אין רכבות מתחנת הבית כרגע — נבדוק שוב בעדכון הבא'; };
    } else {
      const ranked = rankOrBest(state.workPlan);
      const best = ranked.chosen.o;
      const rows = ranked.others;
      const carMin = ranked.chosen.car?.min;
      const fare = ranked.chosen.fare;
      const laterText = state.workPlan.next.slice(1, 3)
        .map((o) => `${o.depDate && o.depDate !== todayYMD() ? `${shortDay(o.depDate)} ` : ''}${o.depHome}`)
        .join(' · ');
      const homeShort = home.name.split(' - ')[0];
      sig = `to/${todayYMD()}/${pref}/${oSig(best)}/${rows.map((r) => r.key + oSig(r.o) + (r.fare ?? '')).join('-')}/${laterText}`;
      hasData = true;
      render = () => {
        el.appendChild(heroEl('hero-eyebrow', 'הכיוון שלי · לעבודה'));
        el.appendChild(big(`🏢 בגב-ים ≈<span class="hero-time"><bdi>${best.arriveGav}</bdi></span> ${dayLabelHtml(best.arriveGavDate)}`));
        const why = whyEl(ranked);
        if (why) el.appendChild(why);
        const doEl = doLine(`🚆 הרכבת ב-<b><bdi>${best.depHome}</bdi></b> מהבית ${dayLabelHtml(best.depDate)}`);
        const cd = countdownEl(best.depDate, best.depHome);
        if (cd) doEl.appendChild(cd);
        el.appendChild(doEl);
        const trainParts = [];
        if (best.boardPlatform) trainParts.push(`רציף ${best.boardPlatform}`);
        if (best.towards) trainParts.push(`לכיוון ${esc(best.towards)}`);
        if (!transfersOf(best).length) trainParts.push('ישיר');
        el.appendChild(heroEl('hero-train', `🚆 ${trainParts.join(' · ') || 'רכבת'}`));
        const metaParts = [`מ${homeShort}`, `מגיע ${best.arriveStation}`];
        if (carMin) metaParts.push(`🚕 ≈${carMin} דק׳`);
        if (fare) metaParts.push(`≈₪${fare}`);
        el.appendChild(detail(metaParts.join(' · ')));
        const chips = transferChips(best);
        if (chips) el.appendChild(chips);

        // חלופות מקופלות כברירת מחדל: תחנות אחרות + שעות נוספות
        const moreChildren = [];
        for (const r of rows) {
          if (r.key === best.stationKey) continue;
          moreChildren.push(optBlockFor(r, 'to'));
        }
        if (laterText) {
          moreChildren.push(altLine((best.depDate !== todayYMD() ? 'נגמרו הרכבות להיום · ' : '') + 'עוד מהבית: ' + laterText));
        }
        const more = moreBlock(moreChildren, moreChildren.length);
        if (more) el.appendChild(more);
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'btn primary sm hero-go';
        goBtn.textContent = state.dir === 'from' ? '🚕 צא לדרך' : '🚆 צא לדרך';
        goBtn.addEventListener('click', () => startJourney(ranked, state.dir));
        el.appendChild(goBtn);
        el.appendChild(prefRow());

        // כפתור "אני על הרכבת" — פרסום מהיר שהרכבת שלי מגיעה (רק עבור רכבת של היום)
        if (best.depDate === todayYMD()) {
          const already = () => state.posts.some((p) =>
            p.token === getToken() && p.direction === 'to' && p.date === todayYMD());
          const rideBtn = document.createElement('button');
          rideBtn.type = 'button';
          rideBtn.className = 'btn primary sm hero-ride';
          if (already()) {
            rideBtn.textContent = '✅ כבר פרסמת נסיעה להיום';
            rideBtn.disabled = true;
          } else {
            rideBtn.textContent = `🚆 אני על הרכבת${best.train ? ` ${best.train}` : ''} — פרסמו שאני מגיע`;
            rideBtn.addEventListener('click', async () => {
              if (already()) {
                toast('כבר יש לך פרסום פעיל להיום 🙂');
                rideBtn.textContent = '✅ כבר פרסמת נסיעה להיום';
                rideBtn.disabled = true;
                return;
              }
              rideBtn.disabled = true;
              try {
                const st = STATIONS.find((s) => s.key === best.stationKey) ?? STATIONS[0];
                await createPost({
                  direction: 'to',
                  station: st.key,
                  origin: st.full,
                  destination: GAV_YAM,
                  date: todayYMD(),
                  time: best.arriveStation,
                  flexible: '',
                  note: `🚆 על הרכבת${best.train ? ` ${best.train}` : ''}${best.towards ? ` לכיוון ${best.towards}` : ''}`,
                  seats: 1,
                });
                missionPassed();
                await refresh();
              } catch (err) {
                toast(err.message);
                rideBtn.disabled = false;
              }
            });
          }
          el.appendChild(rideBtn);
        }
      };
    }
  } else {
    if (!home) {
      sig = 'from/nohome';
      render = () => { el.textContent = '🏠 לחצו כאן לבחירת תחנת הבית — ונחשב מתי תגיעו הביתה'; };
    } else if (!state.homePlan) {
      sig = state.homeError ? 'from/error' : 'from/loading';
      render = () => { el.textContent = state.homeError
        ? '⚠️ לא הצלחנו לטעון את הדרך הביתה — ננסה שוב ברענון הקרוב'
        : '🏠 מחשבים מתי תגיעו הביתה…'; };
    } else if (!state.homePlan.best) {
      sig = 'from/none';
      render = () => { el.textContent = '🏠 אין מסלול זמין כרגע — נבדוק שוב בעדכון הבא'; };
    } else {
      const ranked = rankOrBest(state.homePlan);
      const best = ranked.chosen.o;
      const rows = ranked.others;
      const homeShort = home.name.split(' - ')[0];
      const fare = ranked.chosen.fare;
      const laterText = state.homePlan.next.slice(1, 3)
        .map((o) => `${o.arriveDate && o.arriveDate !== todayYMD() ? `${shortDay(o.arriveDate)} ` : ''}${o.arriveHome}`)
        .join(' · ');
      sig = `from/${todayYMD()}/${pref}/${oSig(best)}/${rows.map((r) => r.key + oSig(r.o) + (r.fare ?? '')).join('-')}/${laterText}`;
      hasData = true;
      render = () => {
        el.appendChild(heroEl('hero-eyebrow', 'הכיוון שלי · הביתה'));
        el.appendChild(big(`🏠 בבית <span class="hero-time"><bdi>${best.arriveHome}</bdi></span> ${dayLabelHtml(best.arriveDate)}`));
        const why = whyEl(ranked);
        if (why) el.appendChild(why);
        const doEl = doLine(`צאו מגב-ים עד <b><bdi>${best.leaveBy}</bdi></b> ${dayLabelHtml(best.leaveByDate)}`);
        const cd = countdownEl(best.leaveByDate, best.leaveBy);
        if (cd) doEl.appendChild(cd);
        el.appendChild(doEl);
        const trainParts = [`${dayLabelHtml(best.departDate)}${best.trainDeparture}`];
        if (best.boardPlatform) trainParts.push(`רציף ${best.boardPlatform}`);
        if (best.towards) trainParts.push(`לכיוון ${esc(best.towards)}`);
        if (!transfersOf(best).length) trainParts.push('ישיר');
        el.appendChild(heroEl('hero-train', `🚆 ${trainParts.join(' · ')}`));
        el.appendChild(detail(`מ${stationShort(best.stationKey)} אל ${homeShort}` + (fare ? ` · ≈₪${fare}` : '')));
        const chips = transferChips(best);
        if (chips) el.appendChild(chips);

        // חלופות מקופלות כברירת מחדל: תחנות אחרות + שעות נוספות
        const moreChildren = [];
        for (const r of rows) {
          if (r.key === best.stationKey) continue;
          moreChildren.push(optBlockFor(r, 'from'));
        }
        if (laterText) {
          moreChildren.push(altLine((best.arriveDate !== todayYMD() ? 'נגמרו הרכבות להיום · ' : '') + 'עוד: ' + laterText));
        }
        const more = moreBlock(moreChildren, moreChildren.length);
        if (more) el.appendChild(more);
        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'btn primary sm hero-go';
        goBtn.textContent = state.dir === 'from' ? '🚕 צא לדרך' : '🚆 צא לדרך';
        goBtn.addEventListener('click', () => startJourney(ranked, state.dir));
        el.appendChild(goBtn);
        el.appendChild(prefRow());
      };
    }
  }

  el.classList.toggle('loading', sig.endsWith('/loading'));
  el.classList.toggle('setup', !home);
  if (sig === state.heroSig) return;
  state.heroSig = sig;
  el.replaceChildren();
  render();
  if (hasData) {
    requestAnimationFrame(() => {
      el.querySelectorAll('.hero-time').forEach((x) => x.classList.add('pop'));
      const chip = el.querySelector('.hero-do b');
      if (chip) chip.classList.add('pop');
    });
  }
}

async function refreshHomePlan() {
  if (!home) { state.homePlan = null; state.homeError = false; renderHero(); return; }
  try {
    const res = await fetch(`/api/home?to=${home.id}`);
    if (!res.ok) throw new Error(`home ${res.status}`);
    const data = await res.json();
    state.homePlan = data.plan;
    state.homeError = false;
  } catch {
    if (!state.homePlan) state.homeError = true; // אין מה להציג — נסמן שגיאה
  }
  renderHero();
}

async function refreshWorkPlan() {
  if (!home) { state.workPlan = null; state.workError = false; renderHero(); return; }
  try {
    const res = await fetch(`/api/work?from=${home.id}`);
    if (!res.ok) throw new Error(`work ${res.status}`);
    const data = await res.json();
    state.workPlan = data.plan;
    state.workError = false;
  } catch {
    if (!state.workPlan) state.workError = true; // אין מה להציג — נסמן שגיאה
  }
  renderHero();
}

function setPanelCollapsed(collapsed) {
  const panel = $('#infoPanel');
  panel.classList.toggle('collapsed', collapsed);
  const btn = $('#infoToggle');
  btn.textContent = collapsed ? 'לוח תחנות ▾' : 'כיווץ ▴';
  btn.setAttribute('aria-expanded', String(!collapsed));
}

$('#infoToggle').addEventListener('click', () => {
  const panel = $('#infoPanel');
  panel.dataset.toggled = '1';
  setPanelCollapsed(!panel.classList.contains('collapsed'));
});

// ------------------------------------------------------------------
// תחנת הבית — פרופיל מקומי במכשיר (localStorage)
// ------------------------------------------------------------------
const HOME_KEY = 'st_home_station';
let home = null;
try { home = JSON.parse(localStorage.getItem(HOME_KEY) || 'null'); } catch { home = null; }
if (!home || !Number.isInteger(home.id) || !home.name) home = null;

let stationsCache = null;

function renderHomeBar() {
  // ההגדרה מוצגת פעם אחת בלבד — בכרטיס ה-hero; אין שורת בחירה כפולה
  $('#homeBar').hidden = true;
  $('#homeEdit').hidden = !home;
}

async function loadStations() {
  if (stationsCache) return stationsCache;
  const res = await fetch('/api/stations');
  if (!res.ok) throw new Error(`stations ${res.status}`);
  const data = await res.json();
  stationsCache = data.stations ?? [];
  return stationsCache;
}

function renderHomeList(query = '') {
  const list = $('#homeList');
  const q = query.trim();
  const items = (stationsCache ?? []).filter((s) => !q || s.name.includes(q));
  if (!items.length) {
    list.innerHTML = '<div class="home-empty">לא נמצאו תחנות מתאימות</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-option' + (home && home.id === s.id ? ' current' : '');
    btn.textContent = s.name;
    btn.addEventListener('click', () => {
      home = { id: s.id, name: s.name };
      localStorage.setItem(HOME_KEY, JSON.stringify(home));
      renderHomeBar();
      renderHomeList($('#homeSearch').value);
      onHomeChanged();
      $('#homeDialog').close();
    });
    frag.appendChild(btn);
  }
  list.replaceChildren(frag);
}

function onHomeChanged() {
  // מתכננים + הלוח מתרעננים; ברירת המחדל של הקיפול חוזרת לפי מצב הבית
  $('#infoPanel').dataset.toggled = '';
  refreshInfo();
}

$('#homeBar').addEventListener('click', openHomeDialog);

async function openHomeDialog() {
  $('#homeDialog').showModal();
  $('#homeList').innerHTML = '<div class="home-empty">טוען תחנות…</div>';
  try {
    await loadStations();
    renderHomeList($('#homeSearch').value);
  } catch {
    $('#homeList').innerHTML = '<div class="home-empty">טעינת התחנות נכשלה — נסו שוב</div>';
  }
}

// כרטיס ה-hero עצמו הוא הכפתור כשעוד לא נבחרה תחנת בית
$('#heroLine').addEventListener('click', () => {
  if (!home) openHomeDialog();
});

$('#homeEdit').addEventListener('click', openHomeDialog);

$('#homeSearch').addEventListener('input', (e) => renderHomeList(e.target.value));
$('#homeForm').addEventListener('submit', (e) => e.preventDefault());
$('#homeClear').addEventListener('click', () => {
  home = null;
  localStorage.removeItem(HOME_KEY);
  renderHomeBar();
  onHomeChanged();
  $('#homeDialog').close();
});
$('#homeClose').addEventListener('click', () => $('#homeDialog').close());

renderHomeBar();

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
    return true;
  } catch (err) {
    state.loading = false;
    list.removeAttribute('aria-busy');
    const block = document.createElement('div');
    block.className = 'empty';
    block.innerHTML = `<span class="big" aria-hidden="true">😵</span>
      <p class="state-text">${esc(err.message)}<br>נסו לרענן.</p>`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn ghost state-retry';
    retry.textContent = 'נסו שוב';
    retry.addEventListener('click', () => refresh());
    block.appendChild(retry);
    list.replaceChildren(block);
    return false;
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

for (const seg of document.querySelectorAll('#seatsSeg .seg')) {
  seg.addEventListener('click', () => {
    seats = Number(seg.dataset.seats) || 1;
    updateSegmented($('#seatsSeg'), 'seats', seg.dataset.seats);
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
      seats,
    });
    try {
      localStorage.setItem('st_last_post', JSON.stringify({
        station: st.key,
        note: $('#note').value.trim(),
        flexible: $('#flexible').value,
        seats,
      }));
    } catch { /* לא קריטי */ }
    dialog.close();
    missionPassed();
    postForm.reset();
    direction = 'toG';
    station = STATIONS[0].key;
    seats = 1;
    updateSegmented($('#directionSeg'), 'direction', direction);
    updateSegmented($('#stationSeg'), 'station', station);
    updateSegmented($('#seatsSeg'), 'seats', '1');
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
function openPostDialog() {
  // הטופס נפתח עם הכיוון הנוכחי שלי; אפשר לשנות בתוך הטופס לפרסום חד-פעמי
  direction = state.dir === 'from' ? 'fromG' : 'toG';
  updateSegmented($('#directionSeg'), 'direction', direction);

  // זוכרים את הנסיעה האחרונה — פרסום חוזר בקלות
  try {
    const last = JSON.parse(localStorage.getItem('st_last_post') || 'null');
    if (last) {
      if (last.station && STATIONS.some((s) => s.key === last.station)) {
        station = last.station;
        updateSegmented($('#stationSeg'), 'station', station);
      }
      if (last.note) $('#note').value = last.note;
      if (last.flexible) $('#flexible').value = last.flexible;
      if (last.seats) {
        seats = last.seats;
        updateSegmented($('#seatsSeg'), 'seats', String(last.seats));
      }
    }
  } catch { /* לא קריטי */ }

  // ברירת מחדל: היום לפי שעון ישראל (לא לפי אזור הזמן של המכשיר)
  $('#date').min = israelDatePlus(0);
  $('#date').max = israelDatePlus(6);
  if (!$('#date').value) $('#date').value = israelDatePlus(0);
  if (!$('#time').value) {
    const epoch = Math.ceil((Date.now() + 5 * 60000) / 300000) * 300000; // עגול ל-5 הדקות הבאות
    const p = israelParts(epoch);
    $('#time').value = `${p.hour}:${p.minute}`;
  }
  dialog.showModal();
}

$('#newPost').addEventListener('click', openPostDialog);
$('#newPostSticky').addEventListener('click', openPostDialog);

for (const btn of document.querySelectorAll('dialog [data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog')?.close());
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

// "הכיוון שלי" — קובע את סינון הלוח ואת ברירת המחדל של הטופס
for (const seg of document.querySelectorAll('#myDirSeg .seg')) {
  seg.addEventListener('click', () => setDirection(seg.dataset.direction === 'toG' ? 'to' : 'from'));
}

$('#infoRefresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    const [, infoOk] = await Promise.all([refresh(), refreshInfo()]);
    if (!infoOk) toast('רענון הלוח נכשל — ננסה שוב אוטומטית');
  } finally {
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
  }
});

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
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update())
    .catch(() => { /* לא קריטי */ });

  // כשגרסה חדשה של ה-SW תופסת פיקוד — מרעננים פעם אחת כדי לקבל את הקבצים החדשים מיד
  if (navigator.serviceWorker.controller) {
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      location.reload();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update()).catch(() => {});
    }
  });
}

let deferredInstall = null;
const installBtn = $('#installBtn'); // יושב בשכבת ה-CTA האחת (אוחד עם הכפתור הדביק)
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
});

// רמז התקנה ל-iOS (לספארי אין beforeinstallprompt)
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
if (isIOS && !isStandalone && !localStorage.getItem('st_ios_hint')) {
  const hint = document.createElement('div');
  hint.className = 'ios-hint';
  hint.innerHTML = '📲 להתקנה באייפון: <b>שיתוף</b> ואז <b>״הוסף למסך הבית״</b> <button type="button" aria-label="סגירת ההמלצה">✕</button>';
  hint.querySelector('button').addEventListener('click', () => {
    localStorage.setItem('st_ios_hint', '1');
    hint.remove();
  });
  const hero = document.querySelector('.hero');
  if (hero) hero.after(hint);
}

// ------------------------------------------------------------------
// 🔔 התראות Push — נסיעות מתאימות + תגובות אליי
// ------------------------------------------------------------------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && isSecureCtx;
const pushBtn = document.createElement('button');
pushBtn.className = 'icon-btn push-btn';
pushBtn.textContent = '🔕';
pushBtn.title = 'הפעלת התראות על נסיעות מתאימות';
pushBtn.setAttribute('aria-label', 'התראות');
pushBtn.hidden = true;
document.querySelector('.info-head-actions').prepend(pushBtn);

let pushSub = null;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function updatePushBtn() {
  if (!pushSupported) return;
  pushBtn.hidden = false;
  pushBtn.textContent = pushSub ? '🔔' : '🔕';
  pushBtn.classList.toggle('on', !!pushSub);
  pushBtn.setAttribute('aria-pressed', String(!!pushSub));
  pushBtn.setAttribute('aria-label', pushSub
    ? `ביטול התראות (${state.dir === 'from' ? 'הביתה' : 'לעבודה'})`
    : 'הפעלת התראות על נסיעות מתאימות');
  pushBtn.title = pushSub
    ? `התראות פעילות ${state.dir === 'from' ? 'לכיוון הביתה' : 'לכיוון העבודה'} — לחיצה לביטול`
    : 'הפעלת התראות על נסיעות מתאימות';
}

async function syncPushPrefs() {
  if (!pushSub) return;
  try {
    await api('/api/push/subscribe', {
      method: 'POST',
      body: { subscription: pushSub.toJSON(), direction: state.dir },
    });
  } catch { /* לא קריטי */ }
}

pushBtn.addEventListener('click', async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (pushSub) {
      const endpoint = pushSub.endpoint;
      await pushSub.unsubscribe();
      pushSub = null;
      updatePushBtn();
      await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint } });
      return;
    }
    if (Notification.permission === 'denied') {
      toast('ההתראות חסומות בדפדפן — אפשר לאשר אותן בהגדרות האתר.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const { key } = await fetch('/api/push/key').then((r) => r.json());
    if (!key) throw new Error('אין מפתח התראות');
    pushSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await api('/api/push/subscribe', {
      method: 'POST',
      body: { subscription: pushSub.toJSON(), direction: state.dir },
    });
    updatePushBtn();
    toast('🔔 התראות הופעלו — נעדכן אותך על נסיעות מתאימות ועל תגובות.');
  } catch (err) {
    toast('לא הצלחנו להפעיל התראות: ' + (err?.message || 'שגיאה'));
  }
});

if (pushSupported) {
  navigator.serviceWorker.ready
    .then((reg) => reg.pushManager.getSubscription())
    .then((sub) => { pushSub = sub; updatePushBtn(); })
    .catch(() => { /* לא קריטי */ });
}

// ------------------------------------------------------------------
// 🔊 מתג צליל + 🚕 מונית חולפת בכניסה הראשונה לסשן
// ------------------------------------------------------------------
updateSoundBtn();
$('#soundToggle').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
  updateSoundBtn();
  if (soundOn) playMissionPassed();
});

if (!sessionStorage.getItem('st_taxi_drive') &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  sessionStorage.setItem('st_taxi_drive', '1');
  const taxi = document.createElement('div');
  taxi.className = 'taxi-drive';
  taxi.textContent = '🚕';
  taxi.setAttribute('aria-hidden', 'true');
  document.body.appendChild(taxi);
  setTimeout(() => taxi.remove(), 5400);
}

// ------------------------------------------------------------------
// שעון ישראל (גם אם המכשיר מוגדר לאזור זמן אחר)
// ------------------------------------------------------------------
function israelParts(epochMs = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))) p[x.type] = x.value;
  return p;
}

function israelDatePlus(days) {
  const p = israelParts(Date.now() + days * 86400000);
  return `${p.year}-${p.month}-${p.day}`;
}

setDirection(defaultDirection() === 'fromG' ? 'from' : 'to');
refresh();
refreshInfo();
