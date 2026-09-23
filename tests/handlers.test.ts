import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleApi,
  handleConfirmFamilyKey
} from "../functions/lib/handlers";
import { getSettings } from "../functions/lib/data";
import { errorResponse } from "../functions/lib/http";
import type { Env } from "../functions/lib/types";
import { addLocalDays, localDateInTokyo } from "../shared/domain";

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
      p256dh: "client-public-key",
      auth: "auth-secret"
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
          body: JSON.stringify({ endpoint: input.endpoint })
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
          body: JSON.stringify({ method: "timer" })
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
          body: JSON.stringify({ method: "timer" })
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

  it("支払いを冪等に一括精算する", async () => {
    await handleApi(
      request(
        "/achievements",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "timer" })
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
    const second = await handleApi(settlementRequest(), env);
    const firstBody = await responseJson<{
      id: string;
      amountYen: number;
      achievementCount: number;
    }>(first);
    const secondBody = await responseJson<{ id: string }>(second);

    expect(first.status).toBe(201);
    expect(firstBody).toMatchObject({ amountYen: 100, achievementCount: 1 });
    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(firstBody.id);
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
          body: JSON.stringify({ method: "timer" })
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
