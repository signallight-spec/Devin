/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setFamilyKey, setParentToken } from "../src/api";

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
