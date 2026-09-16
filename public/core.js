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

  root.PlanningCore = { tzOffsetMs, ilEpoch, rankOptions, SLACK_MIN };
})(typeof window !== 'undefined' ? window : globalThis);
