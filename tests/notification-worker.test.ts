import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processReminder } from "../notifications/worker";

vi.mock("@block65/webcrypto-web-push", () => ({
  buildPushPayload: vi.fn(async () => ({
    method: "POST",
    headers: {},
    body: "encrypted-payload"
  }))
}));

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

type SqlValue = string | number | bigint | Uint8Array | null;

class TestStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: SqlValue[] = []
  ) {}

  bind(...values: SqlValue[]): D1PreparedStatement {
    return new TestStatement(
      this.database,
      this.query,
      values
    ) as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return (
      this.database.prepare(this.query).get(...this.values) ?? null
    ) as T | null;
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
      meta: { changes: result.changes }
    } as unknown as D1Result<T>;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    for (const file of readdirSync(migrationsDirectory).sort()) {
      if (file.endsWith(".sql")) {
        this.sqlite.exec(
          readFileSync(resolve(migrationsDirectory, file), "utf8")
        );
      }
    }
    this.sqlite.exec(`
      INSERT INTO app_settings (
        id, timezone, goal_minutes, family_key_hash, pin_hash,
        notification_time, created_at_utc, updated_at_utc
      ) VALUES (
        1, 'Asia/Tokyo', 25, '${"a".repeat(64)}', 'pin-hash',
        '20:00', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/test', 'key', 'auth',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
  }

  prepare(query: string): D1PreparedStatement {
    return new TestStatement(this.sqlite, query) as unknown as D1PreparedStatement;
  }
}

let database: TestD1;
const env = {
  get DB(): D1Database {
    return database as unknown as D1Database;
  },
  VAPID_SUBJECT: "mailto:test@example.com",
  VAPID_PUBLIC_KEY: "public-key",
  VAPID_PRIVATE_KEY: "private-key"
};

beforeEach(() => {
  database = new TestD1();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 201 }))
  );
});

afterEach(() => {
  database.sqlite.close();
  vi.unstubAllGlobals();
});

describe("未達通知Worker", () => {
  it("未達なら設定時刻後に1日1回だけ送る", async () => {
    const now = new Date("2026-09-23T11:05:00.000Z");

    await expect(processReminder(env, now)).resolves.toBe(1);
    await expect(processReminder(env, now)).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    const delivery = database.sqlite
      .prepare(
        `SELECT local_date, sent_count
         FROM notification_deliveries`
      )
      .get();
    expect(delivery).toEqual({
      local_date: "2026-09-23",
      sent_count: 1
    });
  });

  it("当日の達成があれば通知しない", async () => {
    database.sqlite.exec(`
      INSERT INTO allowance_rules (
        base_amount_yen, bonus_interval_days, bonus_amount_yen,
        effective_from_utc, created_at_utc
      ) VALUES (100, 7, 300, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
      INSERT INTO achievements (
        id, local_date, method, target_minutes, streak_days,
        base_amount_yen, bonus_amount_yen, total_amount_yen,
        allowance_rule_id, achieved_at_utc
      ) VALUES (
        'done', '2026-09-23', 'timer', 25, 1,
        100, 0, 100, 1, '2026-09-23T08:00:00.000Z'
      );
    `);

    await expect(
      processReminder(env, new Date("2026-09-23T11:05:00.000Z"))
    ).resolves.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
