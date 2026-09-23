import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../functions/lib/handlers";
import type { Env } from "../functions/lib/types";
import { addLocalDays, localDateInTokyo } from "../shared/domain";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations/0001_initial.sql"
);

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
      meta: { last_row_id: Number(result.lastInsertRowid) }
    } as unknown as D1Result<T>;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(readFileSync(migrationPath, "utf8"));
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

let testD1: TestD1;
let env: Env;
let familyKey: string;

beforeEach(async () => {
  testD1 = new TestD1();
  env = {
    DB: testD1 as unknown as D1Database,
    BOOTSTRAP_TOKEN: "bootstrap-token",
    PARENT_SESSION_SECRET: "parent-session-secret"
  };
  const response = await handleApi(
    request("/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": "bootstrap-token"
      },
      body: JSON.stringify({ pin: "1234" })
    }),
    env
  );
  familyKey = (await responseJson<{ familyKey: string }>(response)).familyKey;
});

afterEach(() => {
  testD1.close();
});

describe("APIハンドラー", () => {
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
});
