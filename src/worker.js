// Cloudflare Worker: API עבור אתר "מונית משותפת רעננה"
// הנתונים נשמרים ב-Cloudflare KV (חינם). אין מידע אישי — רק טוקן אנונימי אקראי לכל דפדפן.

const POSTS_KEY = "posts";
const MAX_TEXT = 120;
const MAX_NOTE = 300;
const MAX_COMMENT = 300;
const MAX_COMMENTS = 50;
const MAX_POSTS_PER_TOKEN = 5;
const EXPIRE_AFTER_DEPARTURE_MS = 6 * 60 * 60 * 1000; // 6 שעות אחרי שעת היציאה
const EXPIRE_HARD_MS = 7 * 24 * 60 * 60 * 1000; // שבוע מהפרסום

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

function isActive(post, now = Date.now()) {
  const dep = new Date(`${post.date}T${post.time}:00`).getTime();
  if (!Number.isFinite(dep)) return false;
  return dep + EXPIRE_AFTER_DEPARTURE_MS > now &&
    new Date(post.createdAt).getTime() + EXPIRE_HARD_MS > now;
}

async function getActivePosts(env) {
  const posts = await loadPosts(env);
  const active = posts.filter((p) => isActive(p));
  // נקה פוסטים שפג תוקפם רק אם באמת השתנה משהו (חוסך כתיבות KV)
  if (active.length !== posts.length) await savePosts(env, active);
  return active;
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

  if (!destination) return { error: "חסר יעד" };
  if (!origin) return { error: "חסרה נקודת מוצא" };
  if (!isValidDate(date)) return { error: "תאריך לא תקין" };
  if (!isValidTime(time)) return { error: "שעה לא תקינה" };

  return { value: { direction, destination, origin, date, time, flexible, note } };
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
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const token = clientToken(request);

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
