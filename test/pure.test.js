import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  israelEpoch,
  addMinutes,
  nameForToken,
  isValidDate,
  isValidTime,
} from "../src/worker.js";

describe("israelEpoch — שעון ישראל כולל שעון קיץ", () => {
  test("קיץ (IDT, UTC+3): 08:00 מקומית = 05:00 UTC", () => {
    assert.equal(
      new Date(israelEpoch("2026-09-14", "08:00")).toISOString(),
      "2026-09-14T05:00:00.000Z"
    );
  });

  test("חורף (IST, UTC+2): 08:00 מקומית = 06:00 UTC", () => {
    assert.equal(
      new Date(israelEpoch("2026-01-15", "08:00")).toISOString(),
      "2026-01-15T06:00:00.000Z"
    );
  });

  test("קלט לא תקין מחזיר NaN", () => {
    assert.ok(Number.isNaN(israelEpoch("bad", "08:00")));
    assert.ok(Number.isNaN(israelEpoch("2026-09-14", "25:00")));
  });
});

describe("addMinutes — חשבון זמנים על שעון קיר", () => {
  test("חוצה חצות קדימה", () => {
    assert.deepEqual(addMinutes("2026-09-14", "23:50", 20), { date: "2026-09-15", hour: "00:10" });
  });

  test("חוצה חצות אחורה", () => {
    assert.deepEqual(addMinutes("2026-09-14", "00:10", -20), { date: "2026-09-13", hour: "23:50" });
  });
});

describe("nameForToken — שם אנונימי יציב", () => {
  test("אותו טוקן → אותו שם תמיד", () => {
    assert.equal(nameForToken("token-abcdef-1234"), nameForToken("token-abcdef-1234"));
  });

  test("טוקנים שונים → שמות שונים (בדרך כלל)", () => {
    assert.notEqual(nameForToken("token-aaaa"), nameForToken("token-bbbb"));
  });

  test("מחזיר שם לא ריק", () => {
    assert.ok(nameForToken("x".repeat(32)).length > 2);
  });
});

describe("ולידציה", () => {
  test("תאריך", () => {
    assert.equal(isValidDate("2026-09-14"), true);
    assert.equal(isValidDate("14/09/2026"), false);
    assert.equal(isValidDate(""), false);
  });

  test("שעה", () => {
    assert.equal(isValidTime("00:00"), true);
    assert.equal(isValidTime("23:59"), true);
    assert.equal(isValidTime("24:00"), false);
    assert.equal(isValidTime("8:30"), false);
  });
});
