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
  dir: 'to', // הכיוון שלי: 'to' | 'from' — תמיד אחד מהם (ברירת מחדל לפי שעה)
  loading: false,
  cars: null, // זמני נסיעה (עם תנועה) לפי תחנה — מגיע מ-/api/info
  info: null, // תגובת /api/info האחרונה (עבור שורת ה-hero)
  homePlan: null, // תוכנית "מתי בבית" האחרונה
  workPlan: null, // תוכנית הבוקר (מהבית לעבודה) האחרונה
  heroSig: null, // חתימת התוכן של כרטיס ה-hero (לאנימציה רק כשמשתנה)
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
    ? { text: '🏠 חוזרים הביתה', cls: 'from' }
    : { text: '🏢 נוסעים לגב-ים', cls: 'to' };
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
function render() {
  const filtered = state.posts.filter((p) => {
    if (state.filter !== 'all' && postStation(p) !== state.filter) return false;
    return (p.direction === 'from' ? 'from' : 'to') === state.dir;
  });

  if (state.loading) {
    list.innerHTML = '<div class="empty"><span class="big">⏳</span>טוען...</div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty">
        <span class="big">🚕</span>
        <span class="mission">${state.filter !== 'all' ? 'אין משימות בסינון הזה' : 'MISSION START?'}</span><br>
        אין כרגע חיפושי מונית ${state.dir === 'from' ? 'לכיוון הביתה' : 'לגב-ים'}.<br>
        היו הראשונים — לחצו על <b>«מחפשים מונית»</b>!
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
  const car = stationKey ? (state.cars?.[stationKey] ?? TAXI[stationKey]) : null;
  const taxi = car
    ? ` <span class="taxi-hint" data-key="${esc(stationKey)}" title="זמן נסיעה משוער ברכב/מונית בין התחנה לגב-ים">· 🚕 ≈${car.min} דק׳</span>`
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

function updateTaxiHints() {
  for (const el of document.querySelectorAll('.taxi-hint[data-key]')) {
    const car = state.cars?.[el.dataset.key] ?? TAXI[el.dataset.key];
    if (car) el.textContent = `· 🚕 ≈${car.min} דק׳`;
  }
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

function trainTime(t) {
  const el = document.createElement('bdi');
  el.className = 'ir-time';
  el.textContent = t.time;
  if (t.cancelled) {
    el.classList.add('cancel');
    el.title = 'בוטלה';
  } else if (Number.isFinite(t.delay) && t.delay > DELAY_ON_TIME_MAX) {
    el.classList.add('late');
    el.title = `מאחרת ${t.delay} דק׳`;
  } else if (t.platform) {
    el.title = `רציף ${t.platform}`;
  }
  return el;
}

function infoStationRow(station, meta) {
  const row = document.createElement('article');
  row.className = 'info-row';

  const top = document.createElement('span');
  top.className = 'ir-top';

  const name = document.createElement('span');
  name.className = 'ir-name';
  name.textContent = `🚆 ${meta.short}`;
  top.appendChild(name);

  if (station.car) {
    const taxi = document.createElement('span');
    taxi.className = 'ir-taxi';
    taxi.textContent = `🚕 ${station.car.min}׳`;
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
  for (const [arrow, label, items] of [['⬇️', 'מגיעות לתחנה', station.arrivals], ['⬆️', 'יוצאות מהתחנה', station.departures]]) {
    const group = document.createElement('span');
    group.className = 'ir-group';
    group.title = label;
    const dir = document.createElement('span');
    dir.className = 'ir-dir';
    dir.textContent = arrow;
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
        group.appendChild(trainTime(t));
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
  } else {
    statsEl.textContent = '';
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
  if (!panel.dataset.toggled) setPanelCollapsed(!!home);
  $('#infoUpdated').textContent =
    `עודכן ${relTime(new Date(payload.cachedAt).toISOString())}${payload.stale ? ' · מטמון' : ''}`;

  state.info = info;
  renderHero();
}

async function refreshInfo() {
  refreshHomePlan(); // במקביל — לא תלוי בהצלחת לוח הרכבות
  refreshWorkPlan();
  try {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error(`info ${res.status}`);
    renderInfo(await res.json());
  } catch {
    if (!$('#infoPanel').dataset.loaded) $('#infoPanel').hidden = true;
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
const optSub = (text) => { const d = heroEl('hero-opt-sub'); d.textContent = text; return d; };

function transferText(t) {
  const name = (t.stationName ?? '').split(' - ')[0];
  const parts = [];
  if (t.arrivePlatform) parts.push(`יורדים ברציף ${t.arrivePlatform}`);
  if (t.departPlatform) parts.push(`עולים ברציף ${t.departPlatform}`);
  return `החלפה ב${name || 'תחנת מעבר'}` +
    (parts.length ? ` · ${parts.join(' · ')}` : '') +
    (t.departTime ? ` · הרכבת ב-${t.departTime}` : '');
}

function optBlock(prefix, mainText, transfer) {
  const wrapEl = document.createElement('div');
  wrapEl.className = 'hero-opt';
  const main = document.createElement('div');
  main.className = 'hero-opt-main';
  main.textContent = prefix + mainText;
  wrapEl.appendChild(main);
  if (transfer) wrapEl.appendChild(optSub(transferText(transfer)));
  return wrapEl;
}

// כל התחנות עם אפשרות — מסודרות לפי זמן ההגעה ליעד (גב-ים / הבית)
function heroStationRows(plan) {
  const rows = (plan?.stations ?? [])
    .filter((s) => s.options?.length)
    .map((s) => ({ key: s.key, car: s.car, o: s.options[0] }));
  const arriveKey = (o) => o.arriveHome
    ? `${o.arriveDate}T${o.arriveHome}`
    : `${o.arriveGavDate}T${o.arriveGav}`;
  rows.sort((a, b) => arriveKey(a.o).localeCompare(arriveKey(b.o)));
  return rows;
}

// חתימת תוכן לאפשרות — לאנימציה רק כשמשהו משתנה
function oSig(o) {
  return [
    o.depHome ?? o.trainDeparture ?? '', o.arriveStation ?? o.arriveHome ?? '',
    o.arriveGav ?? '', o.leaveBy ?? '', o.boardPlatform ?? '',
    o.transfer ? `${o.transfer.stationId}:${o.transfer.arrivePlatform}:${o.transfer.departPlatform}:${o.transfer.departTime}` : '',
  ].join('|');
}

function renderHero() {
  const el = $('#heroLine');
  let sig;
  let render;
  let hasData = false;

  if (state.dir === 'to') {
    if (!home) {
      sig = 'to/nohome';
      render = () => { el.textContent = '🏠 הגדירו תחנת בית — ונחשב את הדרך מהבית לעבודה'; };
    } else if (!state.workPlan) {
      sig = 'to/loading';
      render = () => { el.textContent = '🚆 מחשבים את הדרך מהבית…'; };
    } else if (!state.workPlan.best) {
      sig = 'to/none';
      render = () => { el.textContent = '🚆 אין רכבות מתחנת הבית כרגע — נבדוק שוב בעדכון הבא'; };
    } else {
      const best = state.workPlan.best;
      const rows = heroStationRows(state.workPlan);
      const carMin = state.workPlan.stations.find((s) => s.key === best.stationKey)?.car?.min;
      const day = best.depDate !== todayYMD() ? `<span class="hero-day">${shortDay(best.depDate)}</span> ` : '';
      const gavDay = best.arriveGavDate !== todayYMD() ? `${shortDay(best.arriveGavDate)} ` : '';
      const later = state.workPlan.next.slice(1, 3).map((o) => o.depHome).join(' · ');
      const homeShort = home.name.split(' - ')[0];
      sig = `to/${oSig(best)}/${rows.map((r) => r.key + oSig(r.o)).join('-')}/${later}`;
      hasData = true;
      render = () => {
        el.appendChild(big(`🚆 רכבת ${day}ב-<span class="hero-time"><bdi>${best.depHome}</bdi></span> מ${esc(home.name)}`));
        el.appendChild(doLine(`🏢 בגב-ים ≈<b><bdi>${gavDay}${best.arriveGav}</bdi></b>`));
        el.appendChild(detail((best.boardPlatform ? `רציף ${best.boardPlatform} ב${homeShort} · ` : '') +
          (best.transfer ? '' : `דרך ${stationShort(best.stationKey)} · `) +
          `מגיע ${best.arriveStation}` +
          (carMin ? ` · 🚕 ~${carMin} דק׳` : '')));
        if (best.transfer) el.appendChild(optSub(transferText(best.transfer)));
        for (const r of rows) {
          if (r.key === best.stationKey) continue;
          el.appendChild(optBlock(`גם דרך ${stationShort(r.key)}: `,
            (r.o.depHome !== best.depHome ? `רכבת ${r.o.depHome} · ` : '') +
            `מגיע ${r.o.arriveStation}` +
            (r.car?.min ? ` · 🚕 ~${r.car.min} דק׳` : '') +
            ` · בגב-ים ${r.o.arriveGav}`,
            r.o.transfer));
        }
        if (later) el.appendChild(altLine('עוד מהבית: ' + later));
      };
    }
  } else {
    if (!home) {
      sig = 'from/nohome';
      render = () => { el.textContent = '🏠 בחרו את תחנת הבית — ונחשב מתי תגיעו הביתה'; };
    } else if (!state.homePlan) {
      sig = 'from/loading';
      render = () => { el.textContent = '🏠 מחשבים מתי תגיעו הביתה…'; };
    } else if (!state.homePlan.best) {
      sig = 'from/none';
      render = () => { el.textContent = '🏠 אין מסלול זמין כרגע — נבדוק שוב בעדכון הבא'; };
    } else {
      const best = state.homePlan.best;
      const rows = heroStationRows(state.homePlan);
      const homeShort = home.name.split(' - ')[0];
      const day = best.arriveDate !== todayYMD() ? `<span class="hero-day">${shortDay(best.arriveDate)}</span> ` : '';
      const later = state.homePlan.next.slice(1, 3).map((o) => o.arriveHome).join(' · ');
      sig = `from/${oSig(best)}/${rows.map((r) => r.key + oSig(r.o)).join('-')}/${later}`;
      hasData = true;
      render = () => {
        el.appendChild(big(`🏠 בבית ${day}ב-<span class="hero-time"><bdi>${best.arriveHome}</bdi></span>`));
        el.appendChild(doLine(`צאו מגב-ים עד <b><bdi>${best.leaveBy}</bdi></b>`));
        el.appendChild(detail(`🚆 ${best.trainDeparture}` +
          (best.boardPlatform ? ` · רציף ${best.boardPlatform}` : '') +
          ` · ${stationShort(best.stationKey)} → ${homeShort}` +
          (best.transfer ? '' : ' · ישיר')));
        if (best.transfer) el.appendChild(optSub(transferText(best.transfer)));
        for (const r of rows) {
          if (r.key === best.stationKey) continue;
          el.appendChild(optBlock(`גם דרך ${stationShort(r.key)}: `,
            `רכבת ${r.o.trainDeparture} · בבית ${r.o.arriveHome} (צאו עד ${r.o.leaveBy})`,
            r.o.transfer));
        }
        if (later) el.appendChild(altLine('עוד: ' + later));
      };
    }
  }

  el.classList.toggle('loading', sig.endsWith('/loading'));
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
  if (!home) { state.homePlan = null; renderHero(); return; }
  try {
    const res = await fetch(`/api/home?to=${home.id}`);
    if (!res.ok) throw new Error(`home ${res.status}`);
    const data = await res.json();
    state.homePlan = data.plan;
  } catch {
    /* נשארים עם התוכנית הקודמת אם יש */
  }
  renderHero();
}

async function refreshWorkPlan() {
  if (!home) { state.workPlan = null; renderHero(); return; }
  try {
    const res = await fetch(`/api/work?from=${home.id}`);
    if (!res.ok) throw new Error(`work ${res.status}`);
    const data = await res.json();
    state.workPlan = data.plan;
  } catch {
    /* נשארים עם התוכנית הקודמת אם יש */
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
  const bar = $('#homeBar');
  if (home) {
    // אין שורת הגדרה שלמה — שינוי הבית זמין בעיפרון הקטן שלצד המתג
    bar.hidden = true;
    $('#homeEdit').hidden = false;
  } else {
    bar.hidden = false;
    bar.classList.remove('set');
    $('#homeLabel').textContent = 'בחרו את תחנת הבית — כדי לדעת מתי תגיעו הביתה';
    bar.title = '';
    $('#homeEdit').hidden = true;
  }
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

$('#homeBar').addEventListener('click', async () => {
  $('#homeDialog').showModal();
  $('#homeList').innerHTML = '<div class="home-empty">טוען תחנות…</div>';
  try {
    await loadStations();
    renderHomeList($('#homeSearch').value);
  } catch {
    $('#homeList').innerHTML = '<div class="home-empty">טעינת התחנות נכשלה — נסו שוב</div>';
  }
});

$('#homeEdit').addEventListener('click', () => $('#homeBar').click());

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
function openPostDialog() {
  // הטופס נפתח עם הכיוון הנוכחי שלי; אפשר לשנות בתוך הטופס לפרסום חד-פעמי
  direction = state.dir === 'from' ? 'fromG' : 'toG';
  updateSegmented($('#directionSeg'), 'direction', direction);

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
}

$('#newPost').addEventListener('click', openPostDialog);
$('#newPostSticky').addEventListener('click', openPostDialog);

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

// "הכיוון שלי" — קובע את סינון הלוח ואת ברירת המחדל של הטופס
for (const seg of document.querySelectorAll('#myDirSeg .seg')) {
  seg.addEventListener('click', () => setDirection(seg.dataset.direction === 'toG' ? 'to' : 'from'));
}

$('#infoRefresh').addEventListener('click', () => { refresh(); refreshInfo(); });

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
const installBtn = document.createElement('button');
installBtn.className = 'icon-btn install-btn';
installBtn.textContent = '📲';
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
document.querySelector('.info-head-actions').prepend(installBtn);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
});

setDirection(defaultDirection() === 'fromG' ? 'from' : 'to');
refresh();
refreshInfo();
