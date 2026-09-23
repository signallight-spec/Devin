import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations/0001_initial.sql"
);

let database: DatabaseSync;

function insertSetup(): void {
  database.exec(`
    INSERT INTO app_settings (
      id, timezone, goal_minutes, family_key_hash, pin_hash,
      created_at_utc, updated_at_utc
    ) VALUES (
      1, 'Asia/Tokyo', 25,
      '${"a".repeat(64)}', 'pin-hash',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO allowance_rules (
      base_amount_yen, bonus_interval_days, bonus_amount_yen,
      effective_from_utc, created_at_utc
    ) VALUES (
      100, 7, 300,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
  `);
}

function insertAchievement(id: string, localDate: string, amount = 100): void {
  database
    .prepare(`
      INSERT INTO achievements (
        id, local_date, method, subject, note, target_minutes, streak_days,
        base_amount_yen, bonus_amount_yen, total_amount_yen,
        allowance_rule_id, achieved_at_utc
      ) VALUES (?, ?, 'timer', NULL, NULL, 25, 1, ?, 0, ?, 1, ?)
    `)
    .run(id, localDate, amount, amount, `${localDate}T01:00:00.000Z`);
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(readFileSync(migrationPath, "utf8"));
  insertSetup();
});

afterEach(() => {
  database.close();
});

describe("D1スキーマ", () => {
  it("同じ日本日付の達成を2件作れない", () => {
    insertAchievement("a1", "2026-09-23");
    expect(() => insertAchievement("a2", "2026-09-23")).toThrow();
  });

  it("ルール変更後も既存達成の金額を固定する", () => {
    insertAchievement("a1", "2026-09-23", 100);
    database.exec(`
      INSERT INTO allowance_rules (
        base_amount_yen, bonus_interval_days, bonus_amount_yen,
        effective_from_utc, created_at_utc
      ) VALUES (
        200, 7, 500,
        '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
      );
    `);
    const result = database
      .prepare("SELECT total_amount_yen FROM achievements WHERE id = 'a1'")
      .get() as { total_amount_yen: number };
    expect(result.total_amount_yen).toBe(100);
  });

  it("支払い対応済みの達成を未払い一覧から除外する", () => {
    insertAchievement("a1", "2026-09-23", 100);
    insertAchievement("a2", "2026-09-24", 400);
    database.exec(`
      INSERT INTO payments (
        id, idempotency_key, amount_yen,
        period_start_date, period_end_date, paid_at_utc
      ) VALUES (
        'p1', 'idempotency-key-1', 100,
        '2026-09-23', '2026-09-23', '2026-09-24T02:00:00.000Z'
      );
      INSERT INTO payment_achievements (payment_id, achievement_id)
      VALUES ('p1', 'a1');
    `);
    const result = database
      .prepare("SELECT id FROM unpaid_achievements ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(result).toEqual([{ id: "a2" }]);
  });

  it("達成1件を複数の支払いへ重複登録できない", () => {
    insertAchievement("a1", "2026-09-23");
    database.exec(`
      INSERT INTO payments (id, idempotency_key, amount_yen, paid_at_utc)
      VALUES ('p1', 'idempotency-key-1', 100, '2026-09-24T02:00:00.000Z');
      INSERT INTO payments (id, idempotency_key, amount_yen, paid_at_utc)
      VALUES ('p2', 'idempotency-key-2', 100, '2026-09-24T03:00:00.000Z');
      INSERT INTO payment_achievements (payment_id, achievement_id)
      VALUES ('p1', 'a1');
    `);
    expect(() =>
      database.exec(`
        INSERT INTO payment_achievements (payment_id, achievement_id)
        VALUES ('p2', 'a1');
      `)
    ).toThrow();
  });

  it("同じ冪等キーの支払いを2件作れない", () => {
    database.exec(`
      INSERT INTO payments (id, idempotency_key, amount_yen, paid_at_utc)
      VALUES ('p1', 'same-idempotency-key', 100, '2026-09-24T02:00:00.000Z');
    `);
    expect(() =>
      database.exec(`
        INSERT INTO payments (id, idempotency_key, amount_yen, paid_at_utc)
        VALUES ('p2', 'same-idempotency-key', 100, '2026-09-24T03:00:00.000Z');
      `)
    ).toThrow();
  });
});
