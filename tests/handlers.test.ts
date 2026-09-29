import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleApi,
  handleConfirmFamilyKey
} from "../functions/lib/handlers";
import { getCurrentRule, getSettings } from "../functions/lib/data";
import { errorResponse } from "../functions/lib/http";
import type { Env } from "../functions/lib/types";
import { addLocalDays, localDateInTokyo } from "../shared/domain";

const VALID_PUSH_PUBLIC_KEY =
  "BN61JE9DZj-_5DlakXIAWcw5HcdoxRrTz2Gc-9ZCLayd6QCiR0G2KqgiTkYD85gSe503T1ueCEXG3O2GHrbZmIs";
const VALID_PUSH_AUTH = "AQEBAQEBAQEBAQEBAQEBAQ";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

function applyMigrations(database: DatabaseSync): void {
  for (const file of readdirSync(migrationsDirectory).sort()) {
    if (file.endsWith(".sql")) {
      database.exec(readFileSync(resolve(migrationsDirectory, file), "utf8"));
    }
  }
}

type SqlValue = string | number | bigint | Uint8Array | null;

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array ||
      value === null
    ) {
      return value;
    }
    throw new TypeError("Unsupported SQL value");
  });
}

class TestStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: SqlValue[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new TestStatement(
      this.database,
      this.query,
      sqlValues(values)
    ) as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return (row ?? null) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.query).all(...this.values) as T[];
    return { results, success: true } as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid)
      }
    } as unknown as D1Result<T>;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    applyMigrations(this.sqlite);
  }

  prepare(query: string): D1PreparedStatement {
    return new TestStatement(this.sqlite, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[]
  ): Promise<D1Result<T>[]> {
    const testStatements = statements as unknown as TestStatement[];
    this.sqlite.exec("BEGIN");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of testStatements) {
        results.push(await statement.run<T>());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

function request(
  path: string,
  init: RequestInit = {},
  familyKey?: string,
  parentToken?: string
): Request {
  const headers = new Headers(init.headers);
  if (familyKey) {
    headers.set("X-Family-Key", familyKey);
  }
  if (parentToken) {
    headers.set("Authorization", `Bearer ${parentToken}`);
  }
  return new Request(`https://example.test/api${path}`, { ...init, headers });
}

async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function handleRequest(requestValue: Request): Promise<Response> {
  try {
    return await handleApi(requestValue, env);
  } catch (error) {
    return errorResponse(error);
  }
}

let testD1: TestD1;
let env: Env;
let familyKey: string;

beforeEach(async () => {
  testD1 = new TestD1();
  env = {
    DB: testD1 as unknown as D1Database,
    BOOTSTRAP_TOKEN: "bootstrap-token",
    PARENT_SESSION_SECRET: "parent-session-secret",
    VAPID_PUBLIC_KEY: "public-key"
  };
  const response = await handleApi(
    request("/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": "bootstrap-token"
      },
      body: JSON.stringify({ pin: "1234", familyKey: "A".repeat(43) })
    }),
    env
  );
  familyKey = (await responseJson<{ familyKey: string }>(response)).familyKey;
});

afterEach(() => {
  testD1.close();
});

describe("APIハンドラー", () => {
  async function parentToken(): Promise<string> {
    const response = await handleApi(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      ),
      env
    );
    return (await responseJson<{ token: string }>(response)).token;
  }

  it("今日の状態へ育成情報と通知設定を含める", async () => {
    const response = await handleApi(request("/today", {}, familyKey), env);
    const body = await responseJson<{
      character: { stage: string; cycleProgressDays: number };
      notification: {
        enabled: boolean;
        time: string;
        available: boolean;
        publicKey: string;
      };
    }>(response);

    expect(body.character).toMatchObject({
      stage: "egg",
      cycleProgressDays: 0
    });
    expect(body.notification).toEqual({
      enabled: true,
      time: "20:00",
      available: true,
      publicKey: "public-key"
    });
  });

  it("AndroidのPush購読を登録・解除する", async () => {
    const input = {
      endpoint: "https://fcm.googleapis.com/fcm/send/subscription-id",
      p256dh: VALID_PUSH_PUBLIC_KEY,
      auth: VALID_PUSH_AUTH,
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    };
    const created = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        familyKey
      ),
      env
    );
    const registered = testD1.sqlite
      .prepare("SELECT endpoint FROM push_subscriptions")
      .get() as { endpoint: string };
    expect(created.status).toBe(204);
    expect(registered.endpoint).toBe(input.endpoint);

    const removed = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: input.endpoint,
            deviceToken: input.deviceToken
          })
        },
        familyKey
      ),
      env
    );
    const count = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM push_subscriptions")
      .get() as { count: number };
    expect(removed.status).toBe(204);
    expect(count.count).toBe(0);

    const rejected = await handleRequest(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input,
            endpoint: "https://example.test/not-a-push-service"
          })
        },
        familyKey
      )
    );
    expect(rejected.status).toBe(400);
  });

  it("別の端末tokenではPush購読を解除できない", async () => {
    const input = {
      endpoint: "https://fcm.googleapis.com/fcm/send/protected-device",
      p256dh: VALID_PUSH_PUBLIC_KEY,
      auth: VALID_PUSH_AUTH,
      deviceId: "66666666-6666-4666-8666-666666666666",
      deviceToken: "11111111-2222-4333-8444-555555555555"
    };
    await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        familyKey
      ),
      env
    );

    const removed = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: input.endpoint,
            deviceToken: "99999999-9999-4999-8999-999999999999"
          })
        },
        familyKey
      ),
      env
    );
    const count = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM push_subscriptions")
      .get() as { count: number };

    expect(removed.status).toBe(204);
    expect(count.count).toBe(1);
  });

  it("Chromeのjmt Push購読はFCMパスだけ登録する", async () => {
    const input = {
      endpoint: "https://jmt17.google.com/fcm/send/subscription-id",
      p256dh: VALID_PUSH_PUBLIC_KEY,
      auth: VALID_PUSH_AUTH,
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    };
    const created = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        familyKey
      ),
      env
    );
    expect(created.status).toBe(204);

    for (const endpoint of [
      "https://jmt17.google.com/not-fcm/subscription-id",
      "https://anything.google.com/fcm/send/subscription-id",
      "https://jmt17.google.com:8443/fcm/send/subscription-id"
    ]) {
      const rejected = await handleRequest(
        request(
          "/push/subscriptions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, endpoint })
          },
          familyKey
        )
      );
      expect(rejected.status).toBe(400);
    }

    for (const invalidKeys of [
      { p256dh: "not-a-public-key", auth: VALID_PUSH_AUTH },
      {
        p256dh:
          "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        auth: VALID_PUSH_AUTH
      },
      { p256dh: VALID_PUSH_PUBLIC_KEY, auth: "not-an-auth-secret" }
    ]) {
      const rejected = await handleRequest(
        request(
          "/push/subscriptions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, ...invalidKeys })
          },
          familyKey
        )
      );
      expect(rejected.status).toBe(400);
    }
  });

  it("別の端末tokenでは既存deviceIdの通知先を置き換えない", async () => {
    const deviceId = "55555555-5555-4555-8555-555555555555";
    const originalEndpoint =
      "https://fcm.googleapis.com/fcm/send/original-device";
    const original = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: originalEndpoint,
            p256dh: VALID_PUSH_PUBLIC_KEY,
            auth: VALID_PUSH_AUTH,
            deviceId,
            deviceToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
          })
        },
        familyKey
      ),
      env
    );
    expect(original.status).toBe(204);

    const replaced = await handleRequest(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://fcm.googleapis.com/fcm/send/other-device",
            p256dh: VALID_PUSH_PUBLIC_KEY,
            auth: VALID_PUSH_AUTH,
            deviceId,
            deviceToken: "ffffffff-ffff-4fff-8fff-ffffffffffff"
          })
        },
        familyKey
      )
    );
    const saved = testD1.sqlite
      .prepare("SELECT endpoint FROM push_subscriptions WHERE device_id = ?")
      .get(deviceId) as { endpoint: string };

    expect(replaced.status).toBe(409);
    expect(saved.endpoint).toBe(originalEndpoint);
  });

  it("Push通知先を正規化し認証情報やフラグメントを拒否する", async () => {
    const input = {
      endpoint: "https://FCM.GOOGLEAPIS.COM/fcm/send/subscription-id",
      p256dh: VALID_PUSH_PUBLIC_KEY,
      auth: VALID_PUSH_AUTH,
      deviceId: "44444444-4444-4444-8444-444444444444",
      deviceToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    };
    const created = await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        familyKey
      ),
      env
    );
    const saved = testD1.sqlite
      .prepare("SELECT endpoint FROM push_subscriptions WHERE device_id = ?")
      .get(input.deviceId) as { endpoint: string };

    expect(created.status).toBe(204);
    expect(saved.endpoint).toBe(
      "https://fcm.googleapis.com/fcm/send/subscription-id"
    );

    for (const endpoint of [
      "https://user@fcm.googleapis.com/fcm/send/subscription-id",
      "https://fcm.googleapis.com/fcm/send/subscription-id#fragment"
    ]) {
      const rejected = await handleRequest(
        request(
          "/push/subscriptions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, endpoint })
          },
          familyKey
        )
      );
      expect(rejected.status).toBe(400);
    }
  });

  it("家族キー再発行は確認まで旧キーと新キーの両方を受け付ける", async () => {
    const token = await parentToken();
    const newFamilyKey = "B".repeat(43);
    const rotated = await handleApi(
      request(
        "/parent/family-key/rotate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyKey: newFamilyKey })
        },
        familyKey,
        token
      ),
      env
    );
    expect(rotated.status).toBe(200);

    expect((await handleApi(request("/today", {}, familyKey), env)).status).toBe(200);
    expect((await handleApi(request("/today", {}, newFamilyKey), env)).status).toBe(200);

    const confirmed = await handleApi(
      request(
        "/parent/family-key/confirm",
        { method: "POST" },
        newFamilyKey,
        token
      ),
      env
    );
    expect(confirmed.status).toBe(204);
    expect((await handleRequest(request("/today", {}, familyKey))).status).toBe(401);
    expect((await handleApi(request("/today", {}, newFamilyKey), env)).status).toBe(200);
    expect(
      (
        await handleRequest(
          request("/parent/dashboard", {}, newFamilyKey, token)
        )
      ).status
    ).toBe(403);
  });

  it("新しい家族キーで登録した通知先は確認後も保持する", async () => {
    const token = await parentToken();
    const newFamilyKey = "B".repeat(43);
    await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://fcm.googleapis.com/fcm/send/old-key",
            p256dh: VALID_PUSH_PUBLIC_KEY,
            auth: VALID_PUSH_AUTH,
            deviceId: "33333333-3333-4333-8333-333333333333",
            deviceToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
          })
        },
        familyKey
      ),
      env
    );
    await handleApi(
      request(
        "/parent/family-key/rotate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyKey: newFamilyKey })
        },
        familyKey,
        token
      ),
      env
    );
    await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://fcm.googleapis.com/fcm/send/new-key",
            p256dh: VALID_PUSH_PUBLIC_KEY,
            auth: VALID_PUSH_AUTH,
            deviceId: "33333333-3333-4333-8333-333333333333",
            deviceToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
          })
        },
        newFamilyKey
      ),
      env
    );
    await handleApi(
      request(
        "/push/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://fcm.googleapis.com/fcm/send/new-key",
            p256dh: VALID_PUSH_PUBLIC_KEY,
            auth: VALID_PUSH_AUTH,
            deviceId: "33333333-3333-4333-8333-333333333333",
            deviceToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
          })
        },
        familyKey
      ),
      env
    );

    const confirmed = await handleApi(
      request(
        "/parent/family-key/confirm",
        { method: "POST" },
        newFamilyKey,
        token
      ),
      env
    );

    expect(confirmed.status).toBe(204);
    const subscriptions = testD1.sqlite
      .prepare(
        `SELECT endpoint, family_key_generation
         FROM push_subscriptions
         ORDER BY endpoint`
      )
      .all() as Array<{
        endpoint: string;
        family_key_generation: string;
      }>;
    expect(subscriptions).toEqual([
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/new-key",
        family_key_generation: "active"
      }
    ]);
  });

  it("確認中にpending家族キーが変わった場合は別のキーを昇格しない", async () => {
    const token = await parentToken();
    const firstFamilyKey = "B".repeat(43);
    const latestFamilyKey = "C".repeat(43);
    await handleApi(
      request(
        "/parent/family-key/rotate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyKey: firstFamilyKey })
        },
        familyKey,
        token
      ),
      env
    );
    const staleSettings = await getSettings(env.DB);
    expect(staleSettings).not.toBeNull();
    await handleApi(
      request(
        "/parent/family-key/rotate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyKey: latestFamilyKey })
        },
        familyKey,
        token
      ),
      env
    );
    testD1.sqlite.exec(`
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/race', 'key', 'auth',
        '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'
      )
    `);

    await expect(
      handleConfirmFamilyKey(
        request(
          "/parent/family-key/confirm",
          { method: "POST" },
          firstFamilyKey,
          token
        ),
        env,
        staleSettings!,
        new Date()
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "PENDING_FAMILY_KEY_CHANGED"
    });
    const subscriptionCount = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM push_subscriptions")
      .get() as { count: number };
    expect(subscriptionCount.count).toBe(1);

    const confirmed = await handleApi(
      request(
        "/parent/family-key/confirm",
        { method: "POST" },
        latestFamilyKey,
        token
      ),
      env
    );
    expect(confirmed.status).toBe(204);
    expect(
      (await handleRequest(request("/today", {}, firstFamilyKey))).status
    ).toBe(401);
    expect(
      (await handleApi(request("/today", {}, latestFamilyKey), env)).status
    ).toBe(200);
  });

  it("重複した家族キー確認は新しく登録された通知先を削除しない", async () => {
    const token = await parentToken();
    const newFamilyKey = "B".repeat(43);
    await handleApi(
      request(
        "/parent/family-key/rotate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ familyKey: newFamilyKey })
        },
        familyKey,
        token
      ),
      env
    );
    const staleSettings = await getSettings(env.DB);
    expect(staleSettings).not.toBeNull();
    const firstConfirmed = await handleApi(
      request(
        "/parent/family-key/confirm",
        { method: "POST" },
        newFamilyKey,
        token
      ),
      env
    );
    expect(firstConfirmed.status).toBe(204);
    testD1.sqlite.exec(`
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/after-confirm', 'key', 'auth',
        '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'
      )
    `);

    await expect(
      handleConfirmFamilyKey(
        request(
          "/parent/family-key/confirm",
          { method: "POST" },
          newFamilyKey,
          token
        ),
        env,
        staleSettings!,
        new Date()
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "PENDING_FAMILY_KEY_CHANGED"
    });
    const subscriptionCount = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM push_subscriptions")
      .get() as { count: number };
    expect(subscriptionCount.count).toBe(1);
  });

  it("親が未達通知のON/OFFと時刻を変更する", async () => {
    const token = await parentToken();
    const response = await handleRequest(
      request(
        "/parent/notifications",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true, time: "19:35" })
        },
        familyKey,
        token
      )
    );
    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toEqual({
      enabled: true,
      time: "19:35"
    });

    const invalid = await handleRequest(
      request(
        "/parent/notifications",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true, time: "19:37" })
        },
        familyKey,
        token
      )
    );
    expect(invalid.status).toBe(400);
  });

  it("同日の再送では既存の達成を返す", async () => {
    const first = await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 25 })
        },
        familyKey
      ),
      env
    );
    const second = await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "self_report" })
        },
        familyKey
      ),
      env
    );
    const firstBody = await responseJson<{
      created: boolean;
      achievement: { id: string };
    }>(first);
    const secondBody = await responseJson<{
      created: boolean;
      achievement: { id: string };
    }>(second);

    expect(first.status).toBe(201);
    expect(firstBody.created).toBe(true);
    expect(second.status).toBe(200);
    expect(secondBody).toEqual({
      created: false,
      achievement: expect.objectContaining({ id: firstBody.achievement.id })
    });
  });

  it("タイマー開始時の目標時間を達成記録へ保存する", async () => {
    testD1.sqlite.exec("UPDATE app_settings SET goal_minutes = 60 WHERE id = 1");
    const response = await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 25 })
        },
        familyKey
      ),
      env
    );
    const body = await responseJson<{
      achievement: { targetMinutes: number };
    }>(response);

    expect(response.status).toBe(201);
    expect(body.achievement.targetMinutes).toBe(25);
  });

  it("5分刻みでないタイマー時間を入力エラーにする", async () => {
    const rejected = await handleRequest(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 6 })
        },
        familyKey
      )
    );
    const body = await responseJson<{ error: { code: string } }>(rejected);

    expect(rejected.status).toBe(400);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("7日目の達成へボーナスを付ける", async () => {
    const today = localDateInTokyo(new Date());
    const insert = testD1.sqlite.prepare(`
      INSERT INTO achievements (
        id, local_date, method, subject, note, target_minutes, streak_days,
        base_amount_yen, bonus_amount_yen, total_amount_yen,
        allowance_rule_id, achieved_at_utc
      ) VALUES (?, ?, 'timer', NULL, NULL, 25, ?, 100, 0, 100, 1, ?)
    `);
    for (let streak = 1; streak <= 6; streak += 1) {
      const localDate = addLocalDays(today, streak - 7);
      insert.run(
        `achievement-${streak}`,
        localDate,
        streak,
        `${localDate}T01:00:00.000Z`
      );
    }

    const response = await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 25 })
        },
        familyKey
      ),
      env
    );
    const body = await responseJson<{
      achievement: {
        streakDays: number;
        bonusAmountYen: number;
        totalAmountYen: number;
      };
    }>(response);

    expect(body.achievement).toMatchObject({
      streakDays: 7,
      bonusAmountYen: 300,
      totalAmountYen: 400
    });
  });

  it("新しい小遣いルールのボーナス間隔を7日に固定する", async () => {
    const token = await parentToken();
    const created = await handleApi(
      request(
        "/parent/allowance-rules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseAmountYen: 150,
            bonusAmountYen: 500
          })
        },
        familyKey,
        token
      ),
      env
    );
    const rule = await responseJson<{ bonusIntervalDays: number }>(created);
    expect(created.status).toBe(201);
    expect(rule.bonusIntervalDays).toBe(7);

    const rejected = await handleRequest(
      request(
        "/parent/allowance-rules",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseAmountYen: 150,
            bonusIntervalDays: 1,
            bonusAmountYen: 500
          })
        },
        familyKey,
        token
      )
    );
    expect(rejected.status).toBe(400);
  });

  it("同じミリ秒の小遣いルールは保存時刻を変えず後の設定を適用する", async () => {
    const token = await parentToken();
    const initialRule = testD1.sqlite
      .prepare(
        `SELECT effective_from_utc
         FROM allowance_rules
         ORDER BY effective_from_utc DESC
         LIMIT 1`
      )
      .get() as { effective_from_utc: string };
    const now = new Date(initialRule.effective_from_utc);
    for (const baseAmountYen of [150, 200]) {
      const response = await handleApi(
        request(
          "/parent/allowance-rules",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseAmountYen,
              bonusAmountYen: 500
            })
          },
          familyKey,
          token
        ),
        env,
        now
      );
      expect(response.status).toBe(201);
    }

    const rules = testD1.sqlite
      .prepare(
        `SELECT id, base_amount_yen, effective_from_utc
         FROM allowance_rules
         WHERE base_amount_yen IN (150, 200)
         ORDER BY id`
      )
      .all() as Array<{
        id: number;
        base_amount_yen: number;
        effective_from_utc: string;
      }>;
    expect(rules).toEqual([
      expect.objectContaining({
        base_amount_yen: 150,
        effective_from_utc: now.toISOString()
      }),
      expect.objectContaining({
        base_amount_yen: 200,
        effective_from_utc: now.toISOString()
      })
    ]);
    const currentRule = await getCurrentRule(env.DB, now.toISOString());
    expect(currentRule?.base_amount_yen).toBe(200);
  });

  it("同じ達成時刻の履歴を複合cursorで欠落なく取得する", async () => {
    testD1.sqlite.exec(`
      INSERT INTO achievements (
        id, local_date, method, target_minutes, streak_days,
        base_amount_yen, bonus_amount_yen, total_amount_yen,
        allowance_rule_id, achieved_at_utc
      ) VALUES
        ('achievement-a', '2026-09-20', 'timer', 25, 1,
         100, 0, 100, 1, '2026-09-23T00:00:00.000Z'),
        ('achievement-b', '2026-09-21', 'timer', 25, 2,
         100, 0, 100, 1, '2026-09-23T00:00:00.000Z');
    `);
    const token = await parentToken();
    const firstResponse = await handleApi(
      request("/parent/achievements?limit=1", {}, familyKey, token),
      env
    );
    const first = await responseJson<{
      items: Array<{ id: string }>;
      nextCursor: string;
    }>(firstResponse);
    const secondResponse = await handleApi(
      request(
        `/parent/achievements?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        {},
        familyKey,
        token
      ),
      env
    );
    const second = await responseJson<{
      items: Array<{ id: string }>;
    }>(secondResponse);

    expect(first.items).toEqual([
      expect.objectContaining({ id: "achievement-b" })
    ]);
    expect(second.items).toEqual([
      expect.objectContaining({ id: "achievement-a" })
    ]);
  });

  it("支払いを冪等に一括精算する", async () => {
    await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 25 })
        },
        familyKey
      ),
      env
    );
    const sessionResponse = await handleApi(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      ),
      env
    );
    const { token } = await responseJson<{ token: string }>(sessionResponse);
    const settlementRequest = () =>
      request(
        "/parent/payments/settle",
        {
          method: "POST",
          headers: { "Idempotency-Key": "integration-idempotency-key" }
        },
        familyKey,
        token
      );

    const first = await handleApi(settlementRequest(), env);
    const nextDate = addLocalDays(localDateInTokyo(new Date()), 1);
    testD1.sqlite.prepare(`
      INSERT INTO achievements (
        id, local_date, method, subject, note, target_minutes, streak_days,
        base_amount_yen, bonus_amount_yen, total_amount_yen,
        allowance_rule_id, achieved_at_utc
      ) VALUES (?, ?, 'timer', NULL, NULL, 25, 1, 100, 0, 100, 1, ?)
    `).run("later-achievement", nextDate, `${nextDate}T01:00:00.000Z`);
    const second = await handleApi(settlementRequest(), env);
    const firstBody = await responseJson<{
      id: string;
      amountYen: number;
      achievementCount: number;
      replayed: boolean;
    }>(first);
    const secondBody = await responseJson<{
      id: string;
      replayed: boolean;
    }>(second);
    const unpaid = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM unpaid_achievements")
      .get() as { count: number };

    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({
      amountYen: 100,
      achievementCount: 1,
      replayed: false
    });
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ id: firstBody.id, replayed: true });
    expect(unpaid.count).toBe(1);
  });

  it("Content-Lengthなしでも4 KiB超のJSONを拒否する", async () => {
    const response = await handleRequest(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "self_report",
            note: "あ".repeat(2000)
          })
        },
        familyKey
      )
    );
    const body = await responseJson<{ error: { code: string } }>(response);

    expect(response.status).toBe(413);
    expect(body.error.code).toBe("REQUEST_TOO_LARGE");
  });

  it("CSV出力で数式として解釈される学習内容を無害化する", async () => {
    await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "self_report",
            subject: "=SUM(A1:A2)",
            note: "一行目\n  @IMPORTXML(\"https://example.test\")"
          })
        },
        familyKey
      ),
      env
    );
    const token = await parentToken();
    const response = await handleApi(
      request("/parent/export.csv", {}, familyKey, token),
      env
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(csv).toContain("\"'=SUM(A1:A2)\"");
    expect(csv).toContain(
      "\"一行目\n  '@IMPORTXML(\"\"https://example.test\"\")\""
    );
  });

  it("金額0円の達成も支払い済みにできる", async () => {
    testD1.sqlite.exec(`
      UPDATE allowance_rules
      SET base_amount_yen = 0, bonus_amount_yen = 0
      WHERE id = 1
    `);
    await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer", targetMinutes: 25 })
        },
        familyKey
      ),
      env
    );
    const sessionResponse = await handleApi(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      ),
      env
    );
    const { token } = await responseJson<{ token: string }>(sessionResponse);
    const settlement = await handleApi(
      request(
        "/parent/payments/settle",
        {
          method: "POST",
          headers: { "Idempotency-Key": "zero-value-settlement" }
        },
        familyKey,
        token
      ),
      env
    );
    const body = await responseJson<{
      amountYen: number;
      achievementCount: number;
    }>(settlement);
    const unpaid = testD1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM unpaid_achievements")
      .get() as { count: number };

    expect(settlement.status).toBe(201);
    expect(body).toMatchObject({ amountYen: 0, achievementCount: 1 });
    expect(unpaid.count).toBe(0);
  });

  it("PINを5回間違えると一時的にロックする", async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await handleRequest(
        request(
          "/parent/session",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: "9999" })
          },
          familyKey
        )
      );
      expect(response.status).toBe(attempt < 5 ? 403 : 429);
    }

    const locked = await handleRequest(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      )
    );
    expect(locked.status).toBe(429);

    testD1.sqlite.exec(`
      UPDATE app_settings
      SET pin_locked_until_utc = '2000-01-01T00:00:00.000Z'
      WHERE id = 1
    `);
    const unlocked = await handleRequest(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      )
    );
    const settings = testD1.sqlite
      .prepare(
        `SELECT pin_failed_attempts, pin_locked_until_utc
         FROM app_settings
         WHERE id = 1`
      )
      .get() as {
      pin_failed_attempts: number;
      pin_locked_until_utc: string | null;
    };

    expect(unlocked.status).toBe(200);
    expect(settings).toEqual({
      pin_failed_attempts: 0,
      pin_locked_until_utc: null
    });
  });

  it("5回目の試行が正しいPINでもロックを回避できない", async () => {
    testD1.sqlite.exec(`
      UPDATE app_settings
      SET pin_failed_attempts = 4, pin_locked_until_utc = NULL
      WHERE id = 1
    `);
    const response = await handleRequest(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "1234" })
        },
        familyKey
      )
    );

    expect(response.status).toBe(429);
  });

  it("期限切れPINロック後の誤入力は失敗回数を1から数え直す", async () => {
    testD1.sqlite.exec(`
      UPDATE app_settings
      SET
        pin_failed_attempts = 5,
        pin_locked_until_utc = '2000-01-01T00:00:00.000Z'
      WHERE id = 1
    `);
    const response = await handleRequest(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "9999" })
        },
        familyKey
      )
    );
    const settings = testD1.sqlite
      .prepare(
        `SELECT pin_failed_attempts, pin_locked_until_utc
         FROM app_settings
         WHERE id = 1`
      )
      .get() as {
      pin_failed_attempts: number;
      pin_locked_until_utc: string | null;
    };

    expect(response.status).toBe(403);
    expect(settings).toEqual({
      pin_failed_attempts: 1,
      pin_locked_until_utc: null
    });
  });

  it("PIN変更後は既存の親セッションを無効化する", async () => {
    const oldToken = await parentToken();
    const updated = await handleApi(
      request(
        "/parent/pin",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPin: "5678" })
        },
        familyKey,
        oldToken
      ),
      env
    );
    expect(updated.status).toBe(204);

    const oldSession = await handleRequest(
      request("/parent/dashboard", {}, familyKey, oldToken)
    );
    expect(oldSession.status).toBe(403);

    const newSession = await handleRequest(
      request(
        "/parent/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: "5678" })
        },
        familyKey
      )
    );
    expect(newSession.status).toBe(200);
  });
});
