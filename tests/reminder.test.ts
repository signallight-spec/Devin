import { describe, expect, it } from "vitest";
import { notificationDue } from "../notifications/reminder";

describe("未達通知時刻", () => {
  it("日本時間の設定時刻までは送らない", () => {
    expect(
      notificationDue(true, "20:00", new Date("2026-09-23T10:59:00.000Z"))
    ).toEqual({ due: false, localDate: "2026-09-23" });
  });

  it("設定時刻以降は同じ日本日付で送信対象にする", () => {
    expect(
      notificationDue(true, "20:00", new Date("2026-09-23T11:05:00.000Z"))
    ).toEqual({ due: true, localDate: "2026-09-23" });
  });

  it("親がOFFにした場合は時刻を過ぎても送らない", () => {
    expect(
      notificationDue(false, "20:00", new Date("2026-09-23T12:00:00.000Z"))
        .due
    ).toBe(false);
  });
});
