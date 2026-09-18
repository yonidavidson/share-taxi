# QA report — share-taxi (live)

**Target:** https://share-taxi.yonidavidson-dev.workers.dev (Cloudflare Worker + KV)
**Date:** 2026-09-18 · **Tester:** automated exploratory QA (agent-browser + Chrome CDP, axe-core, Web Vitals, direct API checks)
**Scope:** load, live board, publish flow, replies, validation, mobile, accessibility, API-level checks.
All test posts were created with the browser's own anonymous token and deleted afterwards (final board state verified: 0 QA posts left).

## How the app works (user guide)

1. **Direction** — pick 🏢 לעבודה (to work) or 🏠 הביתה (home); the app remembers it.
2. **Live board** — per station (רעננה דרום, רעננה מערב, הרצליה): next 2 arrivals and 2 departures, platform, delays, drive-time and price estimates. Refresh button and a collapse toggle.
3. **Publish a ride** — `+ מחפשים מונית`: direction, station, date, time, flexibility, seats (1/2/3+), optional note (max 300 chars). On success the board updates and a "MISSION PASSED" overlay plays.
4. **Coordinate** — open any card and use quick replies (בדרך!, אני שם בעוד 5 דקות, גם אני מצטרף/ת, מקום פנוי?) or free text. Comments are anonymous.
5. **Manage** — you can delete your own posts (per-browser anonymous token). Posts expire 2 hours after the ride time and disappear forever after 7 days.
6. **Extras** — push notifications toggle, sound toggle, PWA install button, "אני על הרכבת" one-tap publish.

## Findings

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | **Medium** | **A ride in the past is accepted, then silently invisible.** POST returns 201 and the UI plays "MISSION PASSED", but the post is filtered out of the board immediately (expiry is computed from the ride time). No error, no hint; the KV record lingers up to 7 days. | `03–08-*.png`, API checks below |
| 2 | Low | **`flexible` is not validated server-side.** The UI sends Hebrew labels (or `""`), but the API accepts any string and cards render it verbatim: posting `flexible: "exact"` showed "(exact)" on the card. Values are HTML-escaped (no XSS), but arbitrary text can appear on the board. | `09-reply-flow.png` |
| 3 | Low | **CLS is 0.1** — exactly at the "needs improvement" threshold. Most likely the Google-Fonts swap and the live-board insertion. | `vitals: cls 0.1`, `a11y/vitals` raw output |
| 4 | Info | Deleting a post uses a **native `confirm()`** dialog — functional, but inconsistent with the app's styled UI (and it blocks automation). | reproduced during cleanup |
| 5 | Info | **No duplicate guard** — publishing the same ride (same date/time/station) twice is allowed. The quick "אני על הרכבת" button does guard against a second same-day post. | code + API |
| 6 | Info | `document.scrollWidth` reports ~2642px on a 390px viewport, but the page is **not horizontally scrollable** and no element renders off-screen — a phantom overflow (likely a closed `<dialog>`), no user impact. | `10-mobile-home.png` + measurements |

### Finding 1 — reproduction (deterministic)

```js
// browser console on the live app (uses the browser's own anonymous token)
fetch("/api/posts", { method: "POST",
  headers: { "content-type": "application/json", "X-Client-Token": localStorage.st_token },
  body: JSON.stringify({ direction: "to", station: "raanana_west", origin: "רעננה מערב",
    destination: "גב-ים", date: "2026-09-17", time: "10:00", flexible: "exact",
    note: "QA direct past", seats: 1 })
})
// → 201 { post: { id: "834c…", date: "2026-09-17", … } }
// immediately after: GET /api/posts → the post is not listed
// control: the same call with tomorrow's date → 201 and listed
```

**Root cause:** client validates only that date/time are non-empty (`postForm` submit); worker `validatePost()` validates the date *format* (`isValidDate`) but not that the departure is in the future. `isExpired()` uses `dep + 2h > now`, so past posts are born expired.

**Suggested fix:** reject `dep < now - 5min` in `validatePost()` with a Hebrew error ("המועד כבר עבר"), and set a `min` on the date input. Optionally keep past posts visible for a short grace window instead of hiding them.

## What's good

- **Fast:** TTFB 21 ms, FCP/LCP 124 ms.
- **Clean:** zero console errors, zero failed requests on load and through the flows.
- **Accessible:** axe-core audit — **0 violations** (desktop).
- **Safe rendering:** `<img onerror=…>` payloads render as text; no script execution, no injected elements.
- **Server-side caps:** 500-char note stored as 300 (`MAX_NOTE`), tokens scoped per browser, deletes verified (200) and board returned to empty.
- **Validation that works:** empty submit shows "בחרו תאריך ושעה." and does not post; reply send is disabled until text is entered.

## Artifacts

```
qa/2026-09-18/
  a11y-desktop.json            axe-core results (0 violations)
  01-desktop-home.png          desktop load
  02-publish-form.png          publish dialog (desktop)
  03..08-*.png                 past-date experiments
  09-reply-flow.png            quick reply + "(exact)" rendering
  10-mobile-home.png           mobile 390×844
  11-mobile-publish-dialog.png mobile publish dialog
```

## Suggested next QA passes

1. Offline / slow-network behavior (train API timeout, KV cold start).
2. Notification permission flows (iOS Safari specifics).
3. Two-browser race: two anonymous users publishing and replying simultaneously.
4. PWA install + update (service worker) across iOS/Android.
