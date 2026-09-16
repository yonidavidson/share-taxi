import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "../public/core.js";

const { ilEpoch, rankOptions, SLACK_MIN } = globalThis.PlanningCore;

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
