// Cloudflare Worker: API עבור אתר "מונית משותפת רעננה"
// הנתונים נשמרים ב-Cloudflare KV (חינם). אין מידע אישי — רק טוקן אנונימי אקראי לכל דפדפן.

const POSTS_KEY = "posts";
const MAX_TEXT = 120;
const MAX_NOTE = 300;
const MAX_COMMENT = 300;
const MAX_COMMENTS = 50;
const MAX_POSTS_PER_TOKEN = 5;
// פוסט פג תוקף שעתיים אחרי שעת היציאה (או שבוע אחרי הפרסום — רשת ביטחון לתאריכים תקולים)
const EXPIRE_AFTER_DEPARTURE_MS = 2 * 60 * 60 * 1000;
const EXPIRE_HARD_MS = 7 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------
// לוח חי — נתוני רכבות מ-rail-api.rail.co.il (אותו API של אתר רכבת ישראל,
// כפי שמשמש את הפרויקט yonidavidson/rakevet). המפתח פומבי (מוטמע באתר) — אינו סוד.
// ------------------------------------------------------------------
const RAIL_API_BASE = "https://rail-api.rail.co.il";
const RAIL_API_KEY = "5e64d66cf03f4547bcac5de2de06b566";
const RAIL_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TLV_SAVIDOR_ID = 3700;
const STATION_IDS = { raananaSouth: 2960, raananaWest: 2940, herzliya: 3500 };
const STATION_KEYS = new Set(Object.keys(STATION_IDS));
// הערכות נסיעה ברכב/מונית אל גב-ים רעננה (רח' זרחין 1) — חושבו מראש ב-OSRM
const CAR_ESTIMATES = {
  raananaSouth: { km: 5.6, min: 10 },
  raananaWest: { km: 5.7, min: 10 },
  herzliya: { km: 9.4, min: 15 },
};
const INFO_CACHE_KEY = "info_cache_v1";
const INFO_TTL_MS = 2 * 60 * 1000; // הגשת מטמון טרי עד 2 דקות
const INFO_STALE_TTL_S = 60 * 60; // שמירת מטמון לגיבוי (stale-while-error)
const STATIONS_CACHE_KEY = "stations_cache_v1";
const STATIONS_CACHE_TTL_S = 24 * 60 * 60; // רשימת התחנות משתנה לעיתים רחוקות
const HOME_CACHE_PREFIX = "home_cache_v1_";
const HOME_CACHE_TTL_MS = 3 * 60 * 1000; // תוכנית הביתה מתרעננת כל 3 דקות
const WORK_CACHE_PREFIX = "work_cache_v1_";
const WORK_CACHE_TTL_MS = 3 * 60 * 1000; // תוכנית הבוקר מתרעננת כל 3 דקות

// ------------------------------------------------------------------
// זמני נסיעה ברכב/מונית — תנועה בזמן אמת מ-TomTom (אם הוגדר מפתח),
// אחרת הערכת עומס טיפוסית לפי שעה (עם סימון "הערכה" ב-UI).
// ------------------------------------------------------------------
const TOMTOM_BASE = "https://api.tomtom.com/routing/1/calculateRoute";
const TRAFFIC_CACHE_KEY = "traffic_cache_v1";
const TRAFFIC_TTL_MS = 10 * 60 * 1000; // תנועה מתרעננת כל 10 דקות
const STATION_COORDS = {
  raananaSouth: { lat: 32.172592, lon: 34.886196 },
  raananaWest: { lat: 32.180012, lon: 34.850805 },
  herzliya: { lat: 32.16380406924, lon: 34.81844813817 },
};
const GAV_YAM_COORD = { lat: 32.1942096, lon: 34.8824513 };

// מקדמי עומס אופייניים בישראל (ימי חול): שיא בוקר, צהריים, שיא ערב; שישי/שבת שונים
function typicalTrafficFactor() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date())) parts[p.type] = p.value;
  const weekday = parts.weekday;
  const hour = Number(parts.hour ?? 12);
  if (weekday === "Fri") return hour >= 8 && hour < 14 ? 1.2 : 1.0;
  if (weekday === "Sat") return 1.0;
  if (hour >= 7 && hour < 9) return 1.5;
  if (hour >= 9 && hour < 11) return 1.3;
  if (hour >= 11 && hour < 15) return 1.15;
  if (hour >= 15 && hour < 19) return 1.45;
  if (hour >= 19 && hour < 21) return 1.15;
  return 1.0;
}

function fallbackCars() {
  const factor = typicalTrafficFactor();
  const out = {};
  for (const [key, base] of Object.entries(CAR_ESTIMATES)) {
    out[key] = { km: base.km, min: Math.max(base.min, Math.ceil(base.min * factor)), live: false };
  }
  return out;
}

async function fetchTomTomTraffic(apiKey) {
  const cars = {};
  const results = await Promise.allSettled(
    Object.entries(STATION_COORDS).map(async ([key, c]) => {
      const url = `${TOMTOM_BASE}/${c.lat},${c.lon}:${GAV_YAM_COORD.lat},${GAV_YAM_COORD.lon}` +
        `/json?key=${encodeURIComponent(apiKey)}&traffic=true&routeType=fastest&travelMode=car&computeTravelTimeFor=all`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`tomtom HTTP ${res.status}`);
      const body = await res.json();
      const summary = body?.routes?.[0]?.summary;
      if (!summary || !Number.isFinite(summary.travelTimeInSeconds)) throw new Error("tomtom no route");
      return [key, {
        km: Math.round((summary.lengthInMeters / 1000) * 10) / 10,
        min: Math.max(1, Math.ceil(summary.travelTimeInSeconds / 60)),
        live: true,
        trafficDelaySec: Number.isFinite(summary.trafficDelayInSeconds) ? summary.trafficDelayInSeconds : 0,
      }];
    })
  );
  for (const r of results) {
    if (r.status === "fulfilled") cars[r.value[0]] = r.value[1];
    else console.error("tomtom leg failed:", r.reason?.message ?? r.reason);
  }
  return cars;
}

// זמני נסיעה לכל שלוש התחנות (אל גב-ים). מטמון KV רק לנתוני אמת.
async function getCarEstimates(env) {
  const apiKey = env.TOMTOM_API_KEY;
  if (!apiKey) return fallbackCars();

  let cached = null;
  try {
    const raw = await env.SHARE_TAXI_KV.get(TRAFFIC_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch { /* מטמון פגום — מרעננים */ }

  if (cached && Date.now() - cached.at < TRAFFIC_TTL_MS && cached.cars) return cached.cars;

  try {
    const live = await fetchTomTomTraffic(apiKey);
    const cars = {};
    const fallback = fallbackCars();
    for (const key of Object.keys(CAR_ESTIMATES)) cars[key] = live[key] ?? fallback[key];
    await env.SHARE_TAXI_KV.put(TRAFFIC_CACHE_KEY, JSON.stringify({ at: Date.now(), cars }), {
      expirationTtl: 3600,
    });
    return cars;
  } catch (err) {
    console.error("live traffic failed:", err);
    if (cached?.cars) return cached.cars;
    return fallbackCars();
  }
}

const ADJECTIVES = [
  "נוסע ענייני", "חבר מסלול", "שותף שקט", "מרחף קליל", "גלגל שינוע",
  "שועל מהיר", "תרנגול בוקר", "דבור מסודר", "ג׳ירפה גבוהה", "פינגווין נחוש",
  "ארנב זריז", "צב יעיל", "ברווז מתואם", "חתול סרק", "דולפין צפוף",
];

const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const randName = () => `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${Math.floor(Math.random() * 99) + 1}`;

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isValidTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

// ------------------------------------------------------------------
// KV helpers — כל הפוסטים במפתח אחד (נפח קטן, תעבורה נמוכה)
// ------------------------------------------------------------------
async function loadPosts(env) {
  const raw = await env.SHARE_TAXI_KV.get("posts");
  const posts = raw ? JSON.parse(raw) : [];
  return Array.isArray(posts) ? posts : [];
}

async function savePosts(env, posts) {
  await env.SHARE_TAXI_KV.put("posts", JSON.stringify(posts));
}

// ------------------------------------------------------------------
// שעון ישראל — Workers רצים ב-UTC, לכן מתרגמים במפורש את שעון ישראל
// ------------------------------------------------------------------
function tzOffsetMs(timeZone, epochMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

// epoch UTC עבור תאריך+שעה לפי שעון ישראל (כולל שעון קיץ)
function israelEpoch(dateStr, timeStr) {
  const guess = Date.parse(`${dateStr}T${timeStr}:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  const off1 = tzOffsetMs("Asia/Jerusalem", guess);
  let ms = guess - off1;
  const off2 = tzOffsetMs("Asia/Jerusalem", ms);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

// התאריך והשעה הנוכחיים בשעון ישראל (לתשאול לוח הרכבות)
function israelNow() {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: `${parts.hour}:${parts.minute}`,
  };
}

function isActive(post, now = Date.now()) {
  const dep = israelEpoch(post.date, post.time);
  if (!Number.isFinite(dep)) return false;
  return dep + EXPIRE_AFTER_DEPARTURE_MS > now &&
    new Date(post.createdAt).getTime() + EXPIRE_HARD_MS > now;
}

// מנקה פוסטים שיצאו מהתוקף. רץ בכל קריאה ובקרון של 3 שעות.
async function pruneExpired(env) {
  const posts = await loadPosts(env);
  const active = posts.filter((p) => isActive(p));
  if (active.length !== posts.length) await savePosts(env, active);
  return active;
}

async function getActivePosts(env) {
  return pruneExpired(env);
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------
function validatePost(body) {
  const direction = body.direction === "from" ? "from" : "to";
  const destination = clean(body.destination, MAX_TEXT);
  const origin = clean(body.origin, MAX_TEXT);
  const date = clean(body.date, 10);
  const time = clean(body.time, 5);
  const flexible = clean(body.flexible, 40);
  const note = clean(body.note, MAX_NOTE);
  const station = clean(body.station, 40);

  if (!destination) return { error: "חסר יעד" };
  if (!origin) return { error: "חסרה נקודת מוצא" };
  if (!isValidDate(date)) return { error: "תאריך לא תקין" };
  if (!isValidTime(time)) return { error: "שעה לא תקינה" };

  return { value: { direction, destination, origin, date, time, flexible, note, station: STATION_KEYS.has(station) ? station : "" } };
}

// ------------------------------------------------------------------
// רכבות — שליפה מ-rail-api (searchTrain) ובניית לוח המידע
// ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rail-api מגן על עצמו לפעמים עם 403 אקראי (bot management) — מנסים שוב עם השהיה קצרה
async function railApi(path, init, attempt = 0) {
  let res;
  try {
    res = await fetch(RAIL_API_BASE + path, {
      ...init,
      headers: {
        "User-Agent": RAIL_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
        "Origin": "https://www.rail.co.il",
        "Referer": "https://www.rail.co.il/",
        "ocp-apim-subscription-key": RAIL_API_KEY,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (attempt < 2) { await sleep(300 + attempt * 400); return railApi(path, init, attempt + 1); }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if ((res.status === 403 || res.status >= 500) && attempt < 2) {
      await sleep(300 + attempt * 400);
      return railApi(path, init, attempt + 1);
    }
    throw new Error(`rail-api HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const body = await res.json();
  if (body.statusCode && body.statusCode !== 200) {
    throw new Error(`rail-api error ${body.statusCode}: ${(body.errorMessages ?? []).join("; ")}`);
  }
  return body.result;
}

function searchTrains(fromStation, toStation, date, hour) {
  return railApi("/rjpa/api/v1/timetable/searchTrain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromStation: String(fromStation),
      toStation: String(toStation),
      date,
      hour,
      scheduleType: "ByDeparture",
      systemType: "2",
      languageId: "Hebrew",
    }),
  }).then((result) => {
    // ה-API מחזיר גם נסיעות שלפני השעה המבוקשת — חותכים לפי startFromIndex הרשמי
    const travels = result?.travels ?? [];
    const start = Number.isInteger(result?.startFromIndex) ? result.startFromIndex : 0;
    const count = Number.isInteger(result?.numOfResultsToShow) ? result.numOfResultsToShow : travels.length;
    return travels.slice(start, start + count);
  });
}

// איחור בדקות של רכבת בתחנה מסוימת (etaDiffTimes: [{stationId, difMin}])
function trainDelay(train, stationId) {
  const entry = (train?.etaDiffTimes ?? []).find((d) => d.stationId === stationId);
  return entry && Number.isFinite(entry.difMin) ? entry.difMin : 0;
}

// הפיכת נסיעה (travel) לפריט לוח מצומצם
function toBoardItem(travel, stationId, kind) {
  const trains = travel?.trains ?? [];
  const first = trains[0];
  const last = trains[trains.length - 1];
  if (!first || !last) return null;
  const relevant = kind === "arrival" ? last : first;
  const iso = String(kind === "arrival" ? travel.arrivalTime : travel.departureTime);
  const platform = kind === "arrival" ? last.destPlatform : first.originPlatform;
  return {
    time: iso.slice(11, 16),
    date: iso.slice(0, 10),
    train: relevant.trainNumber ?? null,
    platform: platform > 0 ? platform : null,
    delay: trainDelay(relevant, stationId),
    cancelled: relevant.isCancelled === true,
    load: Number.isFinite(relevant.predictedPctLoad) ? relevant.predictedPctLoad : null,
    changes: Math.max(0, trains.length - 1),
  };
}

async function buildStationBoard(key, stationId, date, hour) {
  const [arr, dep] = await Promise.allSettled([
    searchTrains(TLV_SAVIDOR_ID, stationId, date, hour),
    searchTrains(stationId, TLV_SAVIDOR_ID, date, hour),
  ]);
  for (const [label, settled] of [["arrivals", arr], ["departures", dep]]) {
    if (settled.status === "rejected") {
      console.error(`rail fetch ${key} ${label} failed:`, settled.reason?.message ?? settled.reason);
    }
  }
  const take = (settled, kind) =>
    settled.status === "fulfilled"
      ? settled.value
          .map((t) => toBoardItem(t, stationId, kind))
          .filter(Boolean)
          // לא מציגים רכבות שכבר יצאו/הגיעו לפני השעה הנוכחית
          .filter((item) => `${item.date}T${item.time}` >= `${date}T${hour}`)
          .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
          .slice(0, 2)
      : [];
  return {
    key,
    ok: arr.status === "fulfilled" || dep.status === "fulfilled",
    arrivals: take(arr, "arrival"),
    departures: take(dep, "departure"),
  };
}

async function buildInfo(env) {
  const { date, hour } = israelNow();
  const [stations, cars] = await Promise.all([
    Promise.all(Object.entries(STATION_IDS).map(([key, stationId]) => buildStationBoard(key, stationId, date, hour))),
    getCarEstimates(env),
  ]);

  const all = stations.flatMap((s) => [...s.arrivals, ...s.departures]);
  const total = all.length;
  const onTime = all.filter((t) => t.delay < 3).length;
  const avgDelay = total ? Math.round((all.reduce((sum, t) => sum + t.delay, 0) / total) * 10) / 10 : 0;

  return {
    updatedAt: Date.now(),
    date,
    hour,
    stations: stations.map((s) => ({ ...s, car: cars[s.key] ?? null })),
    stats: { total, onTime, avgDelay },
  };
}

// מטמון KV: מגישים מידע טרי עד 2 דקות; אם ה-API נופל — מגישים מטמון ישן
async function getInfo(env) {
  let cached = null;
  try {
    const raw = await env.SHARE_TAXI_KV.get(INFO_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch { /* מטמון פגום — מתעלמים */ }

  const now = Date.now();
  if (cached && now - cached.at < INFO_TTL_MS) {
    return { info: cached.info, cachedAt: cached.at, stale: false };
  }
  try {
    const info = await buildInfo(env);
    await env.SHARE_TAXI_KV.put(INFO_CACHE_KEY, JSON.stringify({ at: now, info }), {
      expirationTtl: INFO_STALE_TTL_S,
    });
    return { info, cachedAt: now, stale: false };
  } catch (err) {
    console.error("buildInfo failed:", err);
    if (cached) return { info: cached.info, cachedAt: cached.at, stale: true };
    return null;
  }
}

// רשימת כל תחנות רכבת ישראל (לבחירת תחנת בית) — מטמון ל-24 שעות
async function getStations(env) {
  try {
    const raw = await env.SHARE_TAXI_KV.get(STATIONS_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length) return cached;
    }
  } catch { /* מטמון פגום — מרעננים */ }

  const stations = await railApi("/common/api/v1/stations?languageId=Hebrew&systemType=2");
  const list = (stations ?? [])
    .map((s) => ({ id: s.stationId, name: String(s.stationName ?? "").trim() }))
    .filter((s) => Number.isInteger(s.id) && s.name)
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
  if (list.length) {
    await env.SHARE_TAXI_KV.put(STATIONS_CACHE_KEY, JSON.stringify(list), {
      expirationTtl: STATIONS_CACHE_TTL_S,
    });
  }
  return list;
}

// ------------------------------------------------------------------
// מתכנן "מתי בבית" — מסלולים מגב-ים הביתה דרך שלוש התחנות
// ------------------------------------------------------------------
// חיבור דקות לשעה עירומה (מחרוזות שעון ישראל) בלי תלות באזור זמן
function addMinutes(dateStr, hhmm, minutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    hour: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  };
}

function homeOptionFromTravel(travel, key, carMin, nameById) {
  const trains = travel?.trains ?? [];
  if (!trains.length) return null;
  const departure = String(travel.departureTime);
  const arrival = String(travel.arrivalTime);
  const leaveBy = addMinutes(departure.slice(0, 10), departure.slice(11, 16), -(carMin + 2));
  return {
    stationKey: key,
    train: trains[0].trainNumber ?? null,
    changes: Math.max(0, trains.length - 1),
    trainDeparture: departure.slice(11, 16),
    departDate: departure.slice(0, 10),
    arriveHome: arrival.slice(11, 16),
    arriveDate: arrival.slice(0, 10),
    leaveBy: leaveBy.hour,
    leaveByDate: leaveBy.date,
    ...legInfo(travel, nameById),
  };
}

// רציף עלייה בתחנת המוצא + פרטי החלפה (תחנה, רציפים, שעת הרכבת המחברת)
function legInfo(travel, nameById) {
  const trains = travel?.trains ?? [];
  const first = trains[0];
  if (!first) return {};
  const out = { boardPlatform: first.originPlatform > 0 ? first.originPlatform : null };
  if (trains.length > 1) {
    const second = trains[1];
    const stationId = first.destinationStation;
    out.transfer = {
      stationId,
      stationName: nameById?.[stationId] ?? null,
      arrivePlatform: first.destPlatform > 0 ? first.destPlatform : null,
      departPlatform: second.originPlatform > 0 ? second.originPlatform : null,
      departTime: String(second.departureTime).slice(11, 16),
      train: second.trainNumber ?? null,
    };
  }
  return out;
}

// מיפוי מזהה תחנה לשם (מטמון התחנות)
async function stationNameMap(env) {
  try {
    const stations = await getStations(env);
    return Object.fromEntries(stations.map((s) => [s.id, s.name]));
  } catch (err) {
    console.error("station names failed:", err);
    return {};
  }
}

async function buildHomePlan(env, homeId) {
  const { date, hour } = israelNow();
  const [cars, nameById] = await Promise.all([getCarEstimates(env), stationNameMap(env)]);
  const results = await Promise.allSettled(
    Object.entries(STATION_IDS).map(async ([key, stationId]) => {
      if (stationId === homeId) return { key, car: cars[key] ?? null, options: [] };
      const car = cars[key] ?? { km: 0, min: 10 };
      const buf = addMinutes(date, hour, car.min + 2);
      const travels = await searchTrains(stationId, homeId, buf.date, buf.hour);
      const options = travels
        .map((t) => homeOptionFromTravel(t, key, car.min, nameById))
        .filter(Boolean)
        .filter((o) => `${o.arriveDate}T${o.arriveHome}` >= `${date}T${hour}`)
        // הרכבת חייבת לצאת אחרי שמגיעים לתחנה (לפי חלון ההמתנה שחישבנו)
        .filter((o) => `${o.departDate}T${o.trainDeparture}` >= `${buf.date}T${buf.hour}`)
        .slice(0, 2);
      return { key, car, options };
    })
  );

  const stations = [];
  for (const [i, r] of results.entries()) {
    const key = Object.keys(STATION_IDS)[i];
    if (r.status === "fulfilled") stations.push(r.value);
    else console.error(`home plan ${key} failed:`, r.reason?.message ?? r.reason);
  }

  const all = stations
    .flatMap((s) => s.options)
    .sort((a, b) => `${a.arriveDate}T${a.arriveHome}`.localeCompare(`${b.arriveDate}T${b.arriveHome}`));
  const seen = new Set();
  const next = [];
  for (const o of all) {
    const k = `${o.arriveDate}T${o.arriveHome}`;
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(o);
    if (next.length >= 4) break;
  }
  return { updatedAt: Date.now(), date, hour, homeId, stations, next, best: next[0] ?? null };
}

// מטמון KV לתוכניות הביתה (לפי תחנת יעד)
async function getHomePlan(env, homeId) {
  const cacheKey = HOME_CACHE_PREFIX + homeId;
  let cached = null;
  try {
    const raw = await env.SHARE_TAXI_KV.get(cacheKey);
    if (raw) cached = JSON.parse(raw);
  } catch { /* מטמון פגום — מרעננים */ }

  if (cached && Date.now() - cached.at < HOME_CACHE_TTL_MS) {
    return { plan: cached.plan, cachedAt: cached.at, stale: false };
  }
  try {
    const plan = await buildHomePlan(env, homeId);
    await env.SHARE_TAXI_KV.put(cacheKey, JSON.stringify({ at: Date.now(), plan }), {
      expirationTtl: 3600,
    });
    return { plan, cachedAt: Date.now(), stale: false };
  } catch (err) {
    console.error("buildHomePlan failed:", err);
    if (cached) return { plan: cached.plan, cachedAt: cached.at, stale: true };
    return null;
  }
}

// ------------------------------------------------------------------
// מתכנן בוקר — מהבית לעבודה: רכבות מתחנת הבית אל שלוש התחנות
// ------------------------------------------------------------------
function workOptionFromTravel(travel, key, carMin, nameById) {
  const trains = travel?.trains ?? [];
  if (!trains.length) return null;
  const dep = String(travel.departureTime);
  const arr = String(travel.arrivalTime);
  const gav = addMinutes(arr.slice(0, 10), arr.slice(11, 16), carMin + 2);
  return {
    stationKey: key,
    train: trains[0].trainNumber ?? null,
    changes: Math.max(0, trains.length - 1),
    depHome: dep.slice(11, 16),
    depDate: dep.slice(0, 10),
    arriveStation: arr.slice(11, 16),
    arriveStationDate: arr.slice(0, 10),
    arriveGav: gav.hour,
    arriveGavDate: gav.date,
    ...legInfo(travel, nameById),
  };
}

async function buildWorkPlan(env, homeId) {
  const { date, hour } = israelNow();
  const [cars, nameById] = await Promise.all([getCarEstimates(env), stationNameMap(env)]);
  const results = await Promise.allSettled(
    Object.entries(STATION_IDS).map(async ([key, stationId]) => {
      if (stationId === homeId) return { key, car: cars[key] ?? null, options: [] };
      const car = cars[key] ?? { km: 0, min: 10 };
      const travels = await searchTrains(homeId, stationId, date, hour);
      const options = travels
        .map((t) => workOptionFromTravel(t, key, car.min, nameById))
        .filter(Boolean)
        .filter((o) => `${o.depDate}T${o.depHome}` >= `${date}T${hour}`)
        .filter((o) => `${o.arriveGavDate}T${o.arriveGav}` >= `${date}T${hour}`)
        .slice(0, 2);
      return { key, car, options };
    })
  );

  const stations = [];
  for (const [i, r] of results.entries()) {
    const key = Object.keys(STATION_IDS)[i];
    if (r.status === "fulfilled") stations.push(r.value);
    else console.error(`work plan ${key} failed:`, r.reason?.message ?? r.reason);
  }

  const all = stations
    .flatMap((s) => s.options)
    .sort((a, b) => `${a.arriveGavDate}T${a.arriveGav}`.localeCompare(`${b.arriveGavDate}T${b.arriveGav}`));
  const seen = new Set();
  const next = [];
  for (const o of all) {
    const k = `${o.arriveGavDate}T${o.arriveGav}`;
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(o);
    if (next.length >= 4) break;
  }
  return { updatedAt: Date.now(), date, hour, homeId, stations, next, best: next[0] ?? null };
}

async function getWorkPlan(env, homeId) {
  const cacheKey = WORK_CACHE_PREFIX + homeId;
  let cached = null;
  try {
    const raw = await env.SHARE_TAXI_KV.get(cacheKey);
    if (raw) cached = JSON.parse(raw);
  } catch { /* מטמון פגום — מרעננים */ }

  if (cached && Date.now() - cached.at < WORK_CACHE_TTL_MS) {
    return { plan: cached.plan, cachedAt: cached.at, stale: false };
  }
  try {
    const plan = await buildWorkPlan(env, homeId);
    await env.SHARE_TAXI_KV.put(cacheKey, JSON.stringify({ at: Date.now(), plan }), {
      expirationTtl: 3600,
    });
    return { plan, cachedAt: Date.now(), stale: false };
  } catch (err) {
    console.error("buildWorkPlan failed:", err);
    if (cached) return { plan: cached.plan, cachedAt: cached.at, stale: true };
    return null;
  }
}

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: "שגיאת שרת" }, 500);
      }
    }
    // כל שאר הבקשות — קבצים סטטיים
    return env.ASSETS.fetch(request);
  },

  // קרון: ניקוי פוסטים ישנים כל 3 שעות, שהלוח לא יתמלא זבל
  async scheduled(event, env) {
    const active = await pruneExpired(env);
    console.log(`[cron] ניקוי תקופתי — ${active.length} פוסטים פעילים`);
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const token = clientToken(request);

  // GET /api/work?from=<stationId> — מסלול הבוקר: מהבית לעבודה
  if (method === "GET" && pathname === "/api/work") {
    const from = Number(url.searchParams.get("from"));
    if (!Number.isInteger(from) || from <= 0) return json({ error: "חסר יעד" }, 400);
    const result = await getWorkPlan(env, from);
    if (!result) return json({ error: "מידע הבוקר לא זמין כרגע" }, 502);
    return json(result);
  }

  // GET /api/home?to=<stationId> — מתי מגיעים הביתה דרך שלוש התחנות
  if (method === "GET" && pathname === "/api/home") {
    const to = Number(url.searchParams.get("to"));
    if (!Number.isInteger(to) || to <= 0) return json({ error: "חסר יעד" }, 400);
    const result = await getHomePlan(env, to);
    if (!result) return json({ error: "מידע ההגעה הביתה לא זמין כרגע" }, 502);
    return json(result);
  }

  // GET /api/stations — רשימת כל התחנות (לבחירת תחנת הבית)
  if (method === "GET" && pathname === "/api/stations") {
    try {
      const stations = await getStations(env);
      if (!stations.length) throw new Error("empty stations list");
      return json({ stations });
    } catch (err) {
      console.error("stations failed:", err);
      return json({ error: "רשימת התחנות לא זמינה כרגע" }, 502);
    }
  }

  // GET /api/info — לוח חי: רכבות הבאות + זמני נסיעה (עם מטמון KV)
  if (method === "GET" && pathname === "/api/info") {
    const result = await getInfo(env);
    if (!result) return json({ error: "מידע הרכבות לא זמין כרגע" }, 502);
    return json(result);
  }

  // GET /api/posts
  if (method === "GET" && pathname === "/api/posts") {
    const posts = await getActivePosts(env);
    posts.sort((a, b) =>
      `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`) ||
      new Date(b.createdAt) - new Date(a.createdAt));
    return json({ posts });
  }

  // POST /api/posts
  if (method === "POST" && pathname === "/api/posts") {
    if (!token) return json({ error: "חסר זיהוי אנונימי" }, 400);
    const body = await readJson(request);
    if (!body) return json({ error: "בקשה לא תקינה" }, 400);
    const v = validatePost(body);
    if (v.error) return json({ error: v.error }, 400);

    const posts = await loadPosts(env);
    if (posts.filter((p) => isActive(p) && p.token === token).length >= MAX_POSTS_PER_TOKEN) {
      return json({ error: `אפשר לפרסם עד ${MAX_POSTS_PER_TOKEN} נסיעות פעילות בו-זמנית` }, 429);
    }

    const post = {
      id: id(),
      ...v.value,
      name: randName(),
      token,
      createdAt: new Date().toISOString(),
      comments: [],
    };
    posts.push(post);
    await savePosts(env, posts);
    return json({ post }, 201);
  }

  // POST /api/posts/:id/comments
  const mComment = pathname.match(/^\/api\/posts\/([a-f0-9]+)\/comments$/);
  if (method === "POST" && mComment) {
    if (!token) return json({ error: "חסר זיהוי אנונימי" }, 400);
    const body = await readJson(request);
    if (!body) return json({ error: "בקשה לא תקינה" }, 400);
    const text = clean(body.text, MAX_COMMENT);
    if (!text) return json({ error: "ההודעה ריקה" }, 400);

    const posts = await loadPosts(env);
    const post = posts.find((p) => p.id === mComment[1] && isActive(p));
    if (!post) return json({ error: "הפוסט לא נמצא" }, 404);
    if (post.comments.length >= MAX_COMMENTS) return json({ error: "אין יותר מקום להודעות בפוסט הזה" }, 400);

    const comment = { id: id(), text, name: randName(), token, createdAt: new Date().toISOString() };
    post.comments.push(comment);
    await savePosts(env, posts);
    return json({ comment }, 201);
  }

  // DELETE /api/posts/:id
  const mPost = pathname.match(/^\/api\/posts\/([a-f0-9]+)$/);
  if (method === "DELETE" && mPost) {
    const posts = await loadPosts(env);
    const post = posts.find((p) => p.id === mPost[1]);
    if (!post) return json({ error: "הפוסט לא נמצא" }, 404);
    if (!token || post.token !== token) return json({ error: "אין הרשאה למחוק את הפוסט הזה" }, 403);
    await savePosts(env, posts.filter((p) => p.id !== post.id));
    return json({ ok: true });
  }

  // DELETE /api/posts/:id/comments/:cid
  const mDel = pathname.match(/^\/api\/posts\/([a-f0-9]+)\/comments\/([a-f0-9]+)$/);
  if (method === "DELETE" && mDel) {
    const posts = await loadPosts(env);
    const post = posts.find((p) => p.id === mDel[1]);
    if (!post) return json({ error: "הפוסט לא נמצא" }, 404);
    const comment = post.comments.find((c) => c.id === mDel[2]);
    if (!comment) return json({ error: "ההודעה לא נמצאה" }, 404);
    if (!token || comment.token !== token) return json({ error: "אין הרשאה למחוק את ההודעה הזו" }, 403);
    post.comments = post.comments.filter((c) => c.id !== comment.id);
    await savePosts(env, posts);
    return json({ ok: true });
  }

  return json({ error: "לא נמצא" }, 404);
}

function clientToken(request) {
  const t = request.headers.get("x-client-token");
  return t && t.length >= 8 && t.length <= 64 ? t : null;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
