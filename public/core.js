// core.js — לוגיקת תכנון טהורה: המרות שעון ישראל ודירוג אפשרויות לפי העדפה.
// נטען בדפדפן כ-<script> וכן מיובא בבדיקות (Node) דרך globalThis.
(function (root) {
  'use strict';

  // "זול" מרשה איחור של עד 12 דק׳ מול האפשרות המהירה
  const SLACK_MIN = 12;

  function tzOffsetMs(tz, ms) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms))) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  // שעון ישראל (קיר) → epoch UTC
  function ilEpoch(date, hhmm) {
    if (!date || !hhmm) return NaN;
    const guess = Date.parse(`${date}T${hhmm}:00Z`);
    if (!Number.isFinite(guess)) return NaN;
    return guess - tzOffsetMs('Asia/Jerusalem', guess);
  }

  function arrivalOf(o) {
    return o && o.arriveHome
      ? { date: o.arriveDate, time: o.arriveHome }
      : { date: o?.arriveGavDate, time: o?.arriveGav };
  }

  // ---- מסע: בנייה ומצב ----
  function addMinutes(date, hhmm, minutes) {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return {
      date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
      hour: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
    };
  }
  const isoAt = (date, time) => (date && time ? `${date}T${time}:00` : null);
  const stepEpoch = (iso) => (iso ? ilEpoch(iso.slice(0, 10), iso.slice(11, 16)) : NaN);

  function normalizeTransfers(o) {
    if (Array.isArray(o?.transfers)) return o.transfers;
    return o?.transfer ? [o.transfer] : [];
  }

  // בונה צעדי מסע מתוך אפשרות תוכנית (dir: 'to' | 'from')
  function buildJourney(o, dir, ctx) {
    const steps = [];
    const transfers = normalizeTransfers(o);
    if (dir === 'from') {
      // ערב: גב-ים -> מונית לתחנה -> רכבות -> הבית
      const taxiArr = addMinutes(o.leaveByDate, o.leaveBy, (ctx.carMin ?? 10) + 2);
      steps.push({
        kind: 'taxi',
        fromName: 'גב-ים רעננה',
        toName: ctx.taxiStationName,
        toKey: ctx.taxiStationKey,
        departAt: isoAt(o.leaveByDate, o.leaveBy),
        arriveAt: isoAt(taxiArr.date, taxiArr.hour),
      });
      let depDate = o.departDate ?? o.leaveByDate;
      let depTime = o.trainDeparture;
      let fromName = ctx.taxiStationName;
      let train = o.train;
      let towards = o.towards;
      let platform = o.boardPlatform;
      for (const t of transfers) {
        const arr = addMinutes(t.departDate ?? depDate, t.departTime, -(t.waitMin || 0));
        steps.push({
          kind: 'train', fromName, toName: t.stationName ?? 'החלפה', toId: t.stationId,
          departAt: isoAt(depDate, depTime), arriveAt: isoAt(arr.date, arr.hour),
          train, towards, platform,
        });
        depDate = t.departDate ?? depDate;
        depTime = t.departTime;
        fromName = t.stationName ?? fromName;
        train = t.train;
        towards = t.towards;
        platform = t.departPlatform;
      }
      steps.push({
        kind: 'train', fromName, toName: ctx.homeName, toId: ctx.homeId,
        departAt: isoAt(depDate, depTime), arriveAt: isoAt(o.arriveDate, o.arriveHome),
        train, towards, platform,
      });
    } else {
      // בוקר: הבית -> רכבות -> תחנה -> מונית -> גב-ים
      let depDate = o.depDate;
      let depTime = o.depHome;
      let fromName = ctx.homeName;
      let train = o.train;
      let towards = o.towards;
      let platform = o.boardPlatform;
      const lastArr = { date: o.arriveStationDate, time: o.arriveStation };
      for (const t of transfers) {
        const arr = addMinutes(t.departDate ?? depDate, t.departTime, -(t.waitMin || 0));
        steps.push({
          kind: 'train', fromName, toName: t.stationName ?? 'החלפה', toId: t.stationId,
          departAt: isoAt(depDate, depTime), arriveAt: isoAt(arr.date, arr.hour),
          train, towards, platform,
        });
        depDate = t.departDate ?? depDate;
        depTime = t.departTime;
        fromName = t.stationName ?? fromName;
        train = t.train;
        towards = t.towards;
        platform = t.departPlatform;
      }
      steps.push({
        kind: 'train', fromName, toName: ctx.taxiStationName, toKey: ctx.taxiStationKey,
        departAt: isoAt(depDate, depTime), arriveAt: isoAt(lastArr.date, lastArr.time),
        train, towards, platform,
      });
      steps.push({
        kind: 'taxi',
        fromName: ctx.taxiStationName,
        toName: 'גב-ים רעננה',
        departAt: isoAt(lastArr.date, lastArr.time),
        arriveAt: isoAt(o.arriveGavDate, o.arriveGav),
      });
    }
    return steps.filter((s) => s.departAt || s.arriveAt);
  }

  // מצב כל צעד + האירוע הבא + זמן סיום
  function journeyState(steps, nowMs, doneThrough = -1) {
    const states = steps.map((s, i) => {
      if (i <= doneThrough) return 'done';
      const arr = stepEpoch(s.arriveAt);
      if (Number.isFinite(arr) && nowMs >= arr) return 'done';
      const dep = stepEpoch(s.departAt);
      if (Number.isFinite(dep) && nowMs >= dep) return 'current';
      return 'upcoming';
    });
    let next = null;
    for (let i = 0; i < states.length; i++) {
      if (states[i] !== 'done') {
        next = states[i] === 'current'
          ? { index: i, kind: 'arrive', at: stepEpoch(steps[i].arriveAt) }
          : { index: i, kind: 'depart', at: stepEpoch(steps[i].departAt) };
        break;
      }
    }
    const finishAt = steps.length ? stepEpoch(steps[steps.length - 1].arriveAt) : NaN;
    return { states, next, finishAt };
  }

  // מרחק מטרים (Haversine)
  function distanceM(a, b) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return Infinity;
    const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(s)));
  }

  // options: [{ key, o, fare, changes }] → דירוג לפי העדפה ('cheap' ברירת מחדל)
  function rankOptions(options, pref, slackMin) {
    const slack = Number.isFinite(slackMin) ? slackMin : SLACK_MIN;
    const mode = pref === 'fast' ? 'fast' : 'cheap';
    const list = (options ?? [])
      .map((x) => {
        const a = arrivalOf(x.o);
        return { ...x, arrival: ilEpoch(a.date, a.time) };
      })
      .filter((x) => Number.isFinite(x.arrival));
    if (!list.length) return null;

    const fastest = list
      .slice()
      .sort((a, b) => a.arrival - b.arrival || (a.fare ?? Infinity) - (b.fare ?? Infinity))[0];
    let chosen = fastest;
    if (mode === 'cheap') {
      const affordable = list
        .filter((x) => x.arrival <= fastest.arrival + slack * 60000)
        .sort((a, b) =>
          (a.fare ?? Infinity) - (b.fare ?? Infinity) ||
          (a.changes ?? 9) - (b.changes ?? 9) ||
          a.arrival - b.arrival);
      if (affordable.length) chosen = affordable[0];
    }

    const cheapest = list
      .slice()
      .sort((a, b) => (a.fare ?? Infinity) - (b.fare ?? Infinity))[0];
    const others = list
      .filter((x) => x.key !== chosen.key)
      .sort((a, b) => (mode === 'cheap'
        ? (a.fare ?? Infinity) - (b.fare ?? Infinity) || a.arrival - b.arrival
        : a.arrival - b.arrival));

    const savings = Number.isFinite(chosen.fare) && Number.isFinite(fastest.fare)
      ? fastest.fare - chosen.fare
      : null;
    const delayMin = Math.round((chosen.arrival - fastest.arrival) / 60000);

    return { chosen, fastest, cheapest, others, pref: mode, savings, delayMin };
  }

  root.PlanningCore = { tzOffsetMs, ilEpoch, rankOptions, SLACK_MIN, buildJourney, journeyState, distanceM, stepEpoch, addMinutes };
})(typeof window !== 'undefined' ? window : globalThis);
