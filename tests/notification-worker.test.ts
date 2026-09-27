import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notificationWorker, { processReminder } from "../notifications/worker";

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
    private readonly values: SqlValue[] = [],
    private readonly afterRun?: (query: string) => void
  ) {}

  bind(...values: SqlValue[]): D1PreparedStatement {
    return new TestStatement(
      this.database,
      this.query,
      values,
      this.afterRun
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
    this.afterRun?.(this.query);
    return {
      results: [],
      success: true,
      meta: { changes: result.changes }
    } as unknown as D1Result<T>;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterRun?: (query: string) => void;

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
        endpoint, p256dh, auth, device_id, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/test', 'key', 'auth', 'device-test',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
  }

  prepare(query: string): D1PreparedStatement {
    return new TestStatement(
      this.sqlite,
      query,
      [],
      (executedQuery) => this.afterRun?.(executedQuery)
    ) as unknown as D1PreparedStatement;
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

  it("失敗した購読だけを後続Cronで再試行する", async () => {
    database.sqlite.exec(`
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, device_id, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/retry', 'key', 'auth', 'device-retry',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
    let retryFailed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const endpoint = String(input);
      if (endpoint.endsWith("/retry") && !retryFailed) {
        retryFailed = true;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T11:05:00.000Z");

    await expect(processReminder(env, now)).resolves.toBe(1);
    await expect(processReminder(env, now)).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const deliveries = database.sqlite
      .prepare(
        `SELECT endpoint
         FROM notification_delivery_subscriptions
         ORDER BY endpoint`
      )
      .all();
    expect(deliveries).toEqual([
      { endpoint: "https://fcm.googleapis.com/fcm/send/retry" },
      { endpoint: "https://fcm.googleapis.com/fcm/send/test" }
    ]);
  });

  it("同時起動しても購読ごとのclaimを取れた1回だけ送る", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => fetchResponse);
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T11:05:00.000Z");

    const first = processReminder(env, now);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const second = processReminder(env, now);

    await expect(second).resolves.toBe(0);
    resolveFetch(new Response(null, { status: 201 }));
    await expect(first).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("古いPush失敗応答で更新済み購読を削除しない", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => fetchResponse);
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T11:05:00.000Z");

    const first = processReminder(env, now);
    await new Promise((resolve) => setTimeout(resolve, 0));
    database.sqlite.exec(`
      UPDATE push_subscriptions
      SET p256dh = 'renewed-key',
          auth = 'renewed-auth',
          updated_at_utc = '2026-09-23T11:06:00.000Z'
      WHERE device_id = 'device-test'
    `);
    resolveFetch(new Response(null, { status: 410 }));
    await expect(first).resolves.toBe(0);

    expect(
      database.sqlite
        .prepare(
          `SELECT p256dh, auth
           FROM push_subscriptions
           WHERE device_id = 'device-test'`
        )
        .get()
    ).toEqual({
      p256dh: "renewed-key",
      auth: "renewed-auth"
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 201 }))
    );
    await expect(
      processReminder(env, new Date("2026-09-23T11:10:00.000Z"))
    ).resolves.toBe(1);
  });

  it("結果不明の処理中claimは古くなっても再送しない", async () => {
    database.sqlite.exec(`
      INSERT INTO notification_deliveries
        (local_date, claimed_at_utc, sent_count)
      VALUES ('2026-09-23', '2026-09-23T11:00:00.000Z', 0);
      INSERT INTO notification_delivery_subscriptions
        (local_date, device_id, endpoint, sent_at_utc, status)
      VALUES (
        '2026-09-23',
        'device-test',
        'https://fcm.googleapis.com/fcm/send/test',
        '2026-09-23T11:00:00.000Z',
        'pending'
      );
    `);

    await expect(
      processReminder(env, new Date("2026-09-23T11:20:00.000Z"))
    ).resolves.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("通信結果が不明な場合は同日の再送をしない", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T11:05:00.000Z");

    await expect(processReminder(env, now)).resolves.toBe(0);
    await expect(
      processReminder(env, new Date("2026-09-23T11:25:00.000Z"))
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const claim = database.sqlite
      .prepare(
        `SELECT status, claim_token
         FROM notification_delivery_subscriptions`
      )
      .get() as { status: string; claim_token: string };
    expect(claim.status).toBe("pending");
    expect(claim.claim_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("通知後に購読を解除・再登録しても同じ端末へ再送しない", async () => {
    const now = new Date("2026-09-23T11:05:00.000Z");
    await expect(processReminder(env, now)).resolves.toBe(1);

    database.sqlite.exec(`
      DELETE FROM push_subscriptions
      WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/test';
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, device_id, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/new-endpoint',
        'new-key', 'new-auth', 'device-test',
        '2026-09-23T11:10:00.000Z', '2026-09-23T11:10:00.000Z'
      );
    `);

    await expect(
      processReminder(env, new Date("2026-09-23T11:15:00.000Z"))
    ).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("claim後に達成された場合は送信直前に中止する", async () => {
    let achievementInserted = false;
    database.afterRun = (query) => {
      if (
        achievementInserted ||
        !query.includes(
          "INSERT OR IGNORE INTO notification_delivery_subscriptions"
        )
      ) {
        return;
      }
      achievementInserted = true;
      database.afterRun = undefined;
      database.sqlite.exec(`
        INSERT INTO allowance_rules (
          base_amount_yen, bonus_interval_days, bonus_amount_yen,
          effective_from_utc, created_at_utc
        ) VALUES (
          100, 7, 300,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        );
        INSERT INTO achievements (
          id, local_date, method, target_minutes, streak_days,
          base_amount_yen, bonus_amount_yen, total_amount_yen,
          allowance_rule_id, achieved_at_utc
        ) VALUES (
          'just-finished', '2026-09-23', 'timer', 25, 1,
          100, 0, 100, 1, '2026-09-23T11:05:00.000Z'
        );
      `);
    };

    await expect(
      processReminder(env, new Date("2026-09-23T11:05:00.000Z"))
    ).resolves.toBe(0);

    expect(achievementInserted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const claimCount = database.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM notification_delivery_subscriptions`
      )
      .get() as { count: number };
    expect(claimCount.count).toBe(0);
  });

  it("claim後に通知設定がOFFになった場合は送信しない", async () => {
    database.afterRun = (query) => {
      if (!query.includes("INSERT OR IGNORE INTO notification_delivery_subscriptions")) {
        return;
      }
      database.afterRun = undefined;
      database.sqlite.exec(`
        UPDATE app_settings
        SET notifications_enabled = 0
        WHERE id = 1
      `);
    };

    await expect(
      processReminder(env, new Date("2026-09-23T11:05:00.000Z"))
    ).resolves.toBe(0);

    expect(fetch).not.toHaveBeenCalled();
    const claimCount = database.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM notification_delivery_subscriptions`
      )
      .get() as { count: number };
    expect(claimCount.count).toBe(0);
  });

  it("遅延したCronは実行時の東京日付で判定する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T15:01:00.000Z"));
    let reminder: Promise<void> | undefined;
    const context = {
      waitUntil(promise: Promise<void>) {
        reminder = promise;
      }
    } as ExecutionContext;

    await notificationWorker.scheduled(
      { scheduledTime: new Date("2026-09-23T14:55:00.000Z").getTime() } as ScheduledController,
      env,
      context
    );
    await reminder;

    expect(fetch).not.toHaveBeenCalled();
  });

  it("処理中に東京日付を跨いだ場合は送信しない", async () => {
    const startedAt = new Date("2026-09-23T14:59:59.000Z");
    const crossedMidnight = new Date("2026-09-23T15:00:01.000Z");

    await expect(
      processReminder(env, startedAt, () => crossedMidnight)
    ).resolves.toBe(0);

    expect(fetch).not.toHaveBeenCalled();
    const claimCount = database.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM notification_delivery_subscriptions`
      )
      .get() as { count: number };
    expect(claimCount.count).toBe(0);
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
