import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "../functions/lib/crypto";

describe("PINハッシュ", () => {
  it("対応する反復回数以外の保存値を処理しない", async () => {
    const stored = await hashPin("1234");
    const excessive = stored.replace("pbkdf2$100000$", "pbkdf2$1000000$");

    await expect(verifyPin("1234", excessive)).resolves.toBe(false);
  });
});
