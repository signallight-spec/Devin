import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

function applyMigrations(
  database: DatabaseSync,
  include: (file: string) => boolean = () => true
): void {
  for (const file of readdirSync(migrationsDirectory).sort()) {
    if (file.endsWith(".sql") && include(file)) {
      database.exec(readFileSync(resolve(migrationsDirectory, file), "utf8"));
    }
  }
}

let database: DatabaseSync;

function insertSetup(target = database): void {
  target.exec(`
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

function insertAchievement(
  id: string,
  localDate: string,
  amount = 100,
  target = database
): void {
  target
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
  applyMigrations(database);
  insertSetup();
});

afterEach(() => {
  database.close();
});

describe("D1スキーマ", () => {
  it("既存の達成記録を保持したまま小遣いルール順序を移行する", () => {
    const upgrade = new DatabaseSync(":memory:");
    try {
      applyMigrations(upgrade, (file) => file < "0006_zz");
      insertSetup(upgrade);
      insertAchievement("existing", "2026-09-23", 100, upgrade);
      upgrade.exec(`
        INSERT INTO payments (
          id, idempotency_key, amount_yen,
          period_start_date, period_end_date, paid_at_utc
        ) VALUES (
          'existing-payment', 'existing-idempotency-key', 100,
          '2026-09-23', '2026-09-23', '2026-09-24T00:00:00.000Z'
        );
        INSERT INTO payment_achievements (payment_id, achievement_id)
        VALUES ('existing-payment', 'existing');
      `);
      applyMigrations(upgrade, (file) => file >= "0006_zz");

      expect(upgrade.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        upgrade
          .prepare(
            `SELECT a.id, r.base_amount_yen
             FROM achievements a
             JOIN allowance_rules r ON r.id = a.allowance_rule_id`
          )
          .get()
      ).toEqual({ id: "existing", base_amount_yen: 100 });
      expect(
        upgrade.prepare("SELECT * FROM unpaid_achievements").all()
      ).toEqual([]);
    } finally {
      upgrade.close();
    }
  });

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

  it("同じ有効時刻の小遣いルールを複数保存できる", () => {
    database.exec(`
      INSERT INTO allowance_rules (
        base_amount_yen, bonus_interval_days, bonus_amount_yen,
        effective_from_utc, created_at_utc
      ) VALUES (
        200, 7, 500,
        '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
      );
      INSERT INTO allowance_rules (
        base_amount_yen, bonus_interval_days, bonus_amount_yen,
        effective_from_utc, created_at_utc
      ) VALUES (
        300, 7, 700,
        '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
      );
    `);
    const result = database
      .prepare(`
        SELECT base_amount_yen
        FROM allowance_rules
        ORDER BY effective_from_utc DESC, id DESC
        LIMIT 1
      `)
      .get() as { base_amount_yen: number };
    expect(result.base_amount_yen).toBe(300);
  });

  it("通知購読を削除しても端末別の日次配信履歴を保持する", () => {
    database.exec(`
      INSERT INTO push_subscriptions (
        endpoint, p256dh, auth, device_id, created_at_utc, updated_at_utc
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/test',
        'key', 'auth', 'device-test',
        '2026-09-23T10:00:00.000Z', '2026-09-23T10:00:00.000Z'
      );
      INSERT INTO notification_delivery_subscriptions (
        local_date, device_id, endpoint, sent_at_utc, status
      ) VALUES (
        '2026-09-23', 'device-test',
        'https://fcm.googleapis.com/fcm/send/test',
        '2026-09-23T11:00:00.000Z', 'sent'
      );
      DELETE FROM push_subscriptions
      WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/test';
    `);
    const result = database
      .prepare(`
        SELECT status
        FROM notification_delivery_subscriptions
        WHERE local_date = '2026-09-23'
          AND device_id = 'device-test'
      `)
      .get();
    expect(result).toEqual({ status: "sent" });
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

  it("同じ日へ通知送信記録を2件作れない", () => {
    database.exec(`
      INSERT INTO notification_deliveries
        (local_date, claimed_at_utc, sent_count)
      VALUES ('2026-09-23', '2026-09-23T11:00:00.000Z', 1);
    `);
    expect(() =>
      database.exec(`
        INSERT INTO notification_deliveries
          (local_date, claimed_at_utc, sent_count)
        VALUES ('2026-09-23', '2026-09-23T11:05:00.000Z', 1);
      `)
    ).toThrow();
  });
});
