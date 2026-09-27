import { describe, expect, it } from "vitest";
import { nextHomeRefreshDelay } from "../src/homeRefresh";

describe("ホーム画面の日付更新", () => {
  it("東京日付変更後の再読込失敗時は再試行する", () => {
    expect(
      nextHomeRefreshDelay(
        new Date("2026-09-23T15:00:01.000Z"),
        "2026-09-23",
        false
      )
    ).toBe(30_000);
  });

  it("東京日付変更後の再読込成功時は古い日付で再試行しない", () => {
    expect(
      nextHomeRefreshDelay(
        new Date("2026-09-23T15:00:01.000Z"),
        "2026-09-23",
        true
      )
    ).toBeNull();
  });
});
