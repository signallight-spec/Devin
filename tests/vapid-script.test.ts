import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("VAPID鍵生成", () => {
  it("秘密鍵を標準出力へ表示せず保護されたファイルへ保存する", () => {
    const directory = mkdtempSync(join(tmpdir(), "vapid-"));
    directories.push(directory);
    const envPath = join(directory, ".dev.vars");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/generate-vapid-keys.mjs")],
      {
        encoding: "utf8",
        env: { ...process.env, VAPID_ENV_FILE: envPath }
      }
    );

    expect(result.status).toBe(0);
    const contents = readFileSync(envPath, "utf8");
    const privateKey = contents.match(/^VAPID_PRIVATE_KEY=(.+)$/m)?.[1];
    expect(privateKey).toBeTruthy();
    expect(result.stdout).not.toContain(privateKey);

    const retry = spawnSync(
      process.execPath,
      [resolve("scripts/generate-vapid-keys.mjs")],
      {
        encoding: "utf8",
        env: { ...process.env, VAPID_ENV_FILE: envPath }
      }
    );
    expect(retry.status).not.toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(contents);
  });
});
