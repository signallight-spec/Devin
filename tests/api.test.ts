/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  clearPendingRotatedKey,
  consumeFamilyKeyFromHash,
  familyKeyFromHash,
  getFamilyKey,
  getPendingRotatedKey,
  getPendingSetupKey,
  isInvalidFamilyKeyError,
  setPendingRotatedKey,
  setFamilyKey,
  setParentToken
} from "../src/api";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  setFamilyKey("family-key");
  setParentToken("parent-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("APIクライアント", () => {
  it("家族キーの確定的な無効応答だけを識別する", () => {
    expect(
      isInvalidFamilyKeyError(
        new ApiError(401, "INVALID_FAMILY_KEY", "家族キーが無効です。")
      )
    ).toBe(true);
    expect(
      isInvalidFamilyKeyError(
        new ApiError(429, "RATE_LIMITED", "しばらく待ってください。")
      )
    ).toBe(false);
    expect(isInvalidFamilyKeyError(new TypeError("network failure"))).toBe(false);
  });

  it("QRコードのURL fragmentから家族キーだけを読み取る", () => {
    const familyKey = "A".repeat(43);

    expect(familyKeyFromHash(`#family-key=${familyKey}`)).toBe(familyKey);
    expect(familyKeyFromHash("#family-key=invalid")).toBe("");
    expect(familyKeyFromHash("#parent")).toBe("");
  });

  it("QRコードの家族キーを読んだ後にURL fragmentを削除する", () => {
    const familyKey = "A".repeat(43);
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      history: { replaceState, state: { navigation: "state" } },
      location: {
        hash: `#family-key=${familyKey}`,
        pathname: "/study/",
        search: "?source=qr"
      }
    });

    expect(consumeFamilyKeyFromHash()).toBe(familyKey);
    expect(replaceState).toHaveBeenCalledWith(
      { navigation: "state" },
      "",
      "/study/?source=qr"
    );
  });

  it("タイマー開始時の目標時間を達成APIへ送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          created: true,
          achievement: { id: "achievement-1" }
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createAchievement({
      method: "timer",
      subject: null,
      note: null,
      targetMinutes: 25
    });

    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body)
    ) as { targetMinutes: number };
    expect(requestBody.targetMinutes).toBe(25);
  });

  it("親セッションで明日のおすすめ科目を送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          subject: "社会",
          targetDate: "2026-09-24"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.updateNextSuggestion("社会")).resolves.toEqual({
      subject: "社会",
      targetDate: "2026-09-24"
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/parent/suggestion");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer parent-token");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    ).toEqual({ subject: "社会" });
  });

  it("確認前の再発行キーを再読み込み後も保持する", () => {
    const rotatedKey = "B".repeat(43);
    setPendingRotatedKey(rotatedKey);
    expect(getPendingRotatedKey()).toBe(rotatedKey);
    clearPendingRotatedKey();
    expect(getPendingRotatedKey()).toBe("");
  });

  it("初期設定の結果が不明な場合は同じ家族キーで再試行する", async () => {
    const candidateFamilyKey = "A".repeat(43);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("setup response lost"))
      .mockRejectedValueOnce(new TypeError("validation unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "ALREADY_SETUP",
              message: "初期設定は完了しています。"
            }
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ localDate: "2026-09-24" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      bootstrapToken: "bootstrap-token",
      familyKey: candidateFamilyKey,
      pin: "1234",
      goalMinutes: 25,
      baseAmountYen: 100,
      bonusAmountYen: 300
    };

    await expect(api.setupRecoverable(input)).rejects.toThrow(
      "初期設定の結果を確認できませんでした。同じ家族キーで再試行します。"
    );
    expect(getFamilyKey()).toBe(candidateFamilyKey);
    expect(getPendingSetupKey()).toBe(candidateFamilyKey);
    await expect(api.setupRecoverable(input)).resolves.toMatchObject({
      familyKey: candidateFamilyKey
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      familyKey: string;
    };
    const retryBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body)) as {
      familyKey: string;
    };
    expect(firstBody.familyKey).toBe(candidateFamilyKey);
    expect(retryBody.familyKey).toBe(candidateFamilyKey);
  });

  it("結果不明の初期設定では一時的な検証拒否でも家族キーを保持する", async () => {
    const candidateFamilyKey = "C".repeat(43);
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(new TypeError("setup response lost"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code: "RATE_LIMITED",
                message: "しばらく待ってください。"
              }
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" }
            }
          )
        )
    );

    await expect(
      api.setupRecoverable({
        bootstrapToken: "bootstrap-token",
        familyKey: candidateFamilyKey,
        pin: "1234",
        goalMinutes: 25,
        baseAmountYen: 100,
        bonusAmountYen: 300
      })
    ).rejects.toThrow(
      "初期設定の結果を確認できませんでした。同じ家族キーで再試行します。"
    );
    expect(getFamilyKey()).toBe(candidateFamilyKey);
    expect(getPendingSetupKey()).toBe(candidateFamilyKey);
  });

  it("設定済み環境と競合した無効キーは破棄する", async () => {
    const candidateFamilyKey = "D".repeat(43);
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code: "ALREADY_SETUP",
                message: "初期設定は完了しています。"
              }
            }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" }
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: {
                code: "INVALID_FAMILY_KEY",
                message: "家族キーが正しくありません。"
              }
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" }
            }
          )
        )
    );

    await expect(
      api.setupRecoverable({
        bootstrapToken: "bootstrap-token",
        familyKey: candidateFamilyKey,
        pin: "1234",
        goalMinutes: 25,
        baseAmountYen: 100,
        bonusAmountYen: 300
      })
    ).rejects.toThrow("初期設定は完了しています。");
    expect(getFamilyKey()).toBe("");
    expect(getPendingSetupKey()).toBe("");
  });

  it("精算の通信再試行では同じ冪等性キーを使う", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "payment-id",
            amountYen: 100,
            paidAt: "2026-09-23T00:00:00.000Z",
            periodStartDate: "2026-09-23",
            periodEndDate: "2026-09-23",
            achievementCount: 1
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.settle()).rejects.toThrow("network failure");
    await expect(api.settle()).resolves.toMatchObject({ id: "payment-id" });

    const firstHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(firstHeaders.get("Idempotency-Key")).toBeTruthy();
    expect(secondHeaders.get("Idempotency-Key")).toBe(
      firstHeaders.get("Idempotency-Key")
    );
  });
});
