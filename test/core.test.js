import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "../public/core.js";

const { ilEpoch, rankOptions, SLACK_MIN, buildJourney, journeyState, distanceM } = globalThis.PlanningCore;

const opt = (key, arriveDate, arriveHome, fare, changes = 0) => ({
  key,
  fare,
  changes,
  o: { arriveDate, arriveHome, arriveGavDate: arriveDate, arriveGav: arriveHome },
});

describe("ilEpoch — שעון ישראל", () => {
  test("קיץ: 22:27 מקומית = 19:27 UTC", () => {
    assert.equal(new Date(ilEpoch("2026-09-13", "22:27")).toISOString(), "2026-09-13T19:27:00.000Z");
  });
  test("חורף: 06:48 מקומית = 04:48 UTC", () => {
    assert.equal(new Date(ilEpoch("2026-01-15", "06:48")).toISOString(), "2026-01-15T04:48:00.000Z");
  });
  test("קלט חסר → NaN", () => {
    assert.ok(Number.isNaN(ilEpoch("", "08:00")));
    assert.ok(Number.isNaN(ilEpoch("2026-09-13", "")));
  });
});

describe("rankOptions — העדפת זול/מהיר", () => {
  // הרצליה מהירה ויקרה; רעננה מערב זולה וב-8 דק׳
  const herzliya = opt("herzliya", "2026-09-13", "22:27", 56);
  const raanana = opt("raananaWest", "2026-09-13", "22:35", 32);

  test("ברירת מחדל 'cheap': בוחר את הזולה כשהאיחור ≤12 דק׳", () => {
    const r = rankOptions([herzliya, raanana], "cheap");
    assert.equal(r.chosen.key, "raananaWest");
    assert.equal(r.fastest.key, "herzliya");
    assert.equal(r.savings, 24);
    assert.equal(r.delayMin, 8);
    assert.equal(r.others[0].key, "herzliya");
  });

  test("'cheap' לא מתפשר יותר מדי: הזולה ב-20 דק׳ איחור → נבחר המהיר", () => {
    const lateCheap = opt("raananaWest", "2026-09-13", "22:47", 32);
    const r = rankOptions([herzliya, lateCheap], "cheap");
    assert.equal(r.chosen.key, "herzliya");
    assert.equal(r.cheapest.key, "raananaWest");
  });

  test("'fast': תמיד המהירה", () => {
    const r = rankOptions([herzliya, raanana], "fast");
    assert.equal(r.chosen.key, "herzliya");
    assert.equal(r.others[0].key, "raananaWest");
  });

  test("'fast' עם זמן הגעה זהה — בוחר את הזולה מבין השוות", () => {
    const a = opt("herzliya", "2026-09-13", "22:27", 56);
    const b = opt("raananaWest", "2026-09-13", "22:27", 32);
    const r = rankOptions([a, b], "fast");
    assert.equal(r.chosen.key, "raananaWest");
  });

  test("בין שתי זולות באותו מחיר — המהירה מביניהן", () => {
    const west = opt("raananaWest", "2026-09-13", "22:35", 32);
    const south = opt("raananaSouth", "2026-09-13", "22:40", 32);
    const r = rankOptions([herzliya, west, south], "cheap");
    assert.equal(r.chosen.key, "raananaWest");
  });

  test("התחשבות במספר החלפות בשובר שוויון", () => {
    const westDirect = opt("raananaWest", "2026-09-13", "22:35", 32, 0);
    const southChanged = opt("raananaSouth", "2026-09-13", "22:35", 32, 1);
    const r = rankOptions([herzliya, southChanged, westDirect], "cheap");
    assert.equal(r.chosen.key, "raananaWest");
  });

  test("רשימה ריקה → null", () => {
    assert.equal(rankOptions([], "cheap"), null);
    assert.equal(rankOptions(null, "cheap"), null);
  });

  test("SLACK הוא 12 דק׳", () => {
    assert.equal(SLACK_MIN, 12);
  });
});

describe("buildJourney — בניית צעדי מסע", () => {
  test("ערב עם החלפה: מונית -> רכבת -> המשך -> הבית (רציפים וזמנים)", () => {
    const o = {
      train: 620, towards: 'באר שבע', boardPlatform: 6,
      trainDeparture: '20:58', departDate: '2026-09-13',
      arriveHome: '22:27', arriveDate: '2026-09-13',
      leaveBy: '20:41', leaveByDate: '2026-09-13',
      transfers: [{
        stationId: 2800, stationName: 'בנימינה', arrivePlatform: 3, departPlatform: 2,
        departTime: '21:40', departDate: '2026-09-13', waitMin: 7, train: 7223, towards: 'אשקלון',
      }],
    };
    const steps = buildJourney(o, 'from', {
      homeName: 'קיסריה - פרדס חנה', homeId: 2820,
      taxiStationName: 'רכבת הרצליה', taxiStationKey: 'herzliya', carMin: 15,
    });
    assert.equal(steps.length, 3);
    assert.equal(steps[0].kind, 'taxi');
    assert.equal(steps[0].departAt, '2026-09-13T20:41:00');
    assert.equal(steps[0].arriveAt, '2026-09-13T20:58:00'); // 15+2 דק׳ אחרי
    assert.equal(steps[1].kind, 'train');
    assert.equal(steps[1].departAt, '2026-09-13T20:58:00');
    assert.equal(steps[1].arriveAt, '2026-09-13T21:33:00'); // 21:40 פחות 7 דק׳
    assert.equal(steps[1].platform, 6);
    assert.equal(steps[2].toName, 'קיסריה - פרדס חנה');
    assert.equal(steps[2].departAt, '2026-09-13T21:40:00');
    assert.equal(steps[2].arriveAt, '2026-09-13T22:27:00');
    assert.equal(steps[2].platform, 2); // רציף העלייה של הרכבת המחברת
    assert.equal(steps[2].train, 7223);
  });

  test("בוקר ישיר: רכבת מהבית -> מונית לגב-ים", () => {
    const o = {
      train: 7153, towards: 'מודיעין', boardPlatform: 2,
      depHome: '21:16', depDate: '2026-09-13',
      arriveStation: '22:19', arriveStationDate: '2026-09-13',
      arriveGav: '22:36', arriveGavDate: '2026-09-13',
      transfers: [],
    };
    const steps = buildJourney(o, 'to', {
      homeName: 'חיפה - חוף הכרמל', homeId: 2300,
      taxiStationName: 'רכבת הרצליה', taxiStationKey: 'herzliya', carMin: 15,
    });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].kind, 'train');
    assert.equal(steps[0].departAt, '2026-09-13T21:16:00');
    assert.equal(steps[0].arriveAt, '2026-09-13T22:19:00');
    assert.equal(steps[0].toKey, 'herzliya');
    assert.equal(steps[1].kind, 'taxi');
    assert.equal(steps[1].toName, 'גב-ים רעננה');
    assert.equal(steps[1].arriveAt, '2026-09-13T22:36:00');
  });
});

describe("journeyState — מצבי צעדים", () => {
  const steps = [
    { departAt: '2026-09-13T21:16:00', arriveAt: '2026-09-13T22:19:00' },
    { departAt: '2026-09-13T22:19:00', arriveAt: '2026-09-13T22:36:00' },
  ];

  test("לפני היציאה — הכל עתידי", () => {
    const st = journeyState(steps, ilEpoch('2026-09-13', '20:00'));
    assert.deepEqual(st.states, ['upcoming', 'upcoming']);
    assert.equal(st.next.index, 0);
    assert.equal(st.next.kind, 'depart');
  });

  test("בזמן הקטע הראשון — current והאירוע הבא הוא ההגעה", () => {
    const st = journeyState(steps, ilEpoch('2026-09-13', '21:30'));
    assert.deepEqual(st.states, ['current', 'upcoming']);
    assert.equal(st.next.kind, 'arrive');
  });

  test("בין הקטעים — הראשון done והשני upcoming (עם doneThrough)", () => {
    const st = journeyState(steps, ilEpoch('2026-09-13', '22:20'));
    assert.deepEqual(st.states, ['done', 'current']);
    assert.equal(st.next.index, 1);
    assert.equal(st.next.kind, 'arrive');
  });

  test("הכל הושלם לפי זמן", () => {
    const st = journeyState(steps, ilEpoch('2026-09-13', '23:00'));
    assert.deepEqual(st.states, ['done', 'done']);
    assert.equal(st.next, null);
    assert.ok(Number.isFinite(st.finishAt));
  });
});

describe("distanceM — קרבה לתחנות", () => {
  test("אותה נקודה = 0", () => {
    assert.equal(distanceM({ lat: 32.18, lon: 34.85 }, { lat: 32.18, lon: 34.85 }), 0);
  });
  test("בין רעננה מערב לגב-ים ~2.5-3.5 ק״מ", () => {
    const d = distanceM({ lat: 32.180012, lon: 34.850805 }, { lat: 32.1942096, lon: 34.8824513 });
    assert.ok(d > 2500 && d < 3500, `got ${d}`);
  });
  test("קלט חסר → Infinity", () => {
    assert.equal(distanceM(null, { lat: 1, lon: 1 }), Infinity);
  });
});
