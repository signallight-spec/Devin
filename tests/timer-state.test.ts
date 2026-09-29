import { describe, expect, it } from "vitest";
import {
  parsePersistedTimer,
  serializePersistedTimer
} from "../src/timerState";

describe("タイマー保存状態", () => {
  it("同じ東京日付の終了状態と開始時目標を復元する", () => {
    const timer = {
      endsAt: Date.parse("2026-09-23T14:55:00.000Z"),
      localDate: "2026-09-23",
      goalMinutes: 25
    };

    expect(
      parsePersistedTimer(
        serializePersistedTimer(timer),
        new Date("2026-09-23T14:59:00.000Z")
      )
    ).toEqual(timer);
  });

  it("東京日付が変わったタイマーを復元しない", () => {
    const timer = {
      endsAt: Date.parse("2026-09-23T14:55:00.000Z"),
      localDate: "2026-09-23",
      goalMinutes: 25
    };

    expect(
      parsePersistedTimer(
        serializePersistedTimer(timer),
        new Date("2026-09-23T15:01:00.000Z")
      )
    ).toBeNull();
  });

  it("旧形式や不正な目標時間を復元しない", () => {
    const now = new Date("2026-09-23T10:00:00.000Z");

    expect(parsePersistedTimer("123456789", now)).toBeNull();
    expect(
      parsePersistedTimer(
        JSON.stringify({
          endsAt: now.getTime() + 60_000,
          localDate: "2026-09-23",
          goalMinutes: 0
        }),
        now
      )
    ).toBeNull();
  });
});
