import {
  addLocalDays,
  calculateCharacterState,
  calculateReward,
  calculateStreak,
  displayedStreak,
  localDateInTokyo,
  mondayWeekRange
} from "../../shared/domain";
import {
  createParentSession,
  familyKeyMatches,
  generateFamilyKey,
  hashPin,
  requireValidParentSession,
  sha256Hex,
  verifyPin
} from "./crypto";
import {
  ACHIEVEMENT_WITH_PAID,
  getCurrentRule,
  getSettings,
  mapAchievement,
  mapPayment,
  mapRule,
  PAYMENT_WITH_COUNT
} from "./data";
import {
  csv,
  empty,
  HttpError,
  integerInRange,
  json,
  optionalTrimmedString,
  readJsonObject,
  rejectUnknownKeys,
  requiredString
} from "./http";
import type {
  AchievementRow,
  AllowanceRuleRow,
  AppSettingsRow,
  Env,
  PaymentRow
} from "./types";

interface AggregateRow {
  count: number;
  amount: number;
  oldest: string | null;
  newest: string | null;
}

interface LatestStreakRow {
  local_date: string;
  streak_days: number;
}

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 5;
const FAMILY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUSH_SERVICE_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com"
]);

function randomCharacterSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % 2_147_483_647 || 1;
}

function normalizedPath(url: URL): string {
  const withoutPrefix = url.pathname.replace(/^\/api/, "");
  if (withoutPrefix.length > 1 && withoutPrefix.endsWith("/")) {
    return withoutPrefix.slice(0, -1);
  }
  return withoutPrefix || "/";
}

function isGoalMinutes(value: number): boolean {
  return value >= 5 && value <= 180 && value % 5 === 0;
}

function isNotificationTime(value: string): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return Boolean(match && Number(match[2]) % 5 === 0);
}

function requireRule(
  row: AllowanceRuleRow | null
): asserts row is AllowanceRuleRow {
  if (!row) {
    throw new HttpError(500, "MISSING_ALLOWANCE_RULE", "小遣いルールが未設定です。");
  }
}

async function requireFamilyKey(
  request: Request,
  settings: AppSettingsRow
): Promise<void> {
  const familyKey = request.headers.get("x-family-key");
  if (
    !familyKey ||
    (!(await familyKeyMatches(familyKey, settings.family_key_hash)) &&
      (!settings.pending_family_key_hash ||
        !(await familyKeyMatches(familyKey, settings.pending_family_key_hash))))
  ) {
    throw new HttpError(401, "INVALID_FAMILY_KEY", "家族キーが無効です。");
  }
}

async function pendingFamilyKeyMatches(
  request: Request,
  settings: AppSettingsRow
): Promise<boolean> {
  const familyKey = request.headers.get("x-family-key");
  return Boolean(
    familyKey &&
      settings.pending_family_key_hash &&
      (await familyKeyMatches(familyKey, settings.pending_family_key_hash))
  );
}

async function latestStreak(
  db: D1Database,
  today: string
): Promise<number> {
  const latest = await db
    .prepare(
      `SELECT local_date, streak_days
       FROM achievements
       ORDER BY local_date DESC
       LIMIT 1`
    )
    .first<LatestStreakRow>();
  return displayedStreak(
    latest?.local_date ?? null,
    latest?.streak_days ?? null,
    today
  );
}

async function handleSetup(request: Request, env: Env, now: Date): Promise<Response> {
  if (!env.BOOTSTRAP_TOKEN) {
    throw new HttpError(500, "MISSING_SECRET", "初期設定用Secretが未設定です。");
  }
  if (request.headers.get("x-bootstrap-token") !== env.BOOTSTRAP_TOKEN) {
    throw new HttpError(403, "INVALID_BOOTSTRAP_TOKEN", "初期設定トークンが無効です。");
  }
  if (await getSettings(env.DB)) {
    throw new HttpError(409, "ALREADY_SETUP", "初期設定は完了しています。");
  }

  const body = await readJsonObject(request);
  rejectUnknownKeys(body, [
    "pin",
    "familyKey",
    "goalMinutes",
    "baseAmountYen",
    "bonusIntervalDays",
    "bonusAmountYen"
  ]);
  const pin = requiredString(body, "pin", /^\d{4}$/);
  const suppliedFamilyKey = optionalTrimmedString(body, "familyKey", 64);
  if (suppliedFamilyKey && !FAMILY_KEY_PATTERN.test(suppliedFamilyKey)) {
    throw new HttpError(400, "INVALID_INPUT", "familyKeyが正しくありません。");
  }
  const goalMinutes = integerInRange(body, "goalMinutes", 5, 180, 25);
  if (!isGoalMinutes(goalMinutes)) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "goalMinutesは5分刻みにしてください。"
    );
  }
  const baseAmountYen = integerInRange(body, "baseAmountYen", 0, 100_000, 100);
  const bonusIntervalDays = integerInRange(
    body,
    "bonusIntervalDays",
    1,
    365,
    7
  );
  const bonusAmountYen = integerInRange(
    body,
    "bonusAmountYen",
    0,
    100_000,
    300
  );
  const familyKey = suppliedFamilyKey ?? generateFamilyKey();
  const characterSeed = randomCharacterSeed();
  const [familyKeyHash, pinHash] = await Promise.all([
    sha256Hex(familyKey),
    hashPin(pin)
  ]);
  const nowIso = now.toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO app_settings
            (id, timezone, goal_minutes, family_key_hash, pin_hash,
             character_seed, created_at_utc, updated_at_utc)
           VALUES (1, 'Asia/Tokyo', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          goalMinutes,
          familyKeyHash,
          pinHash,
          characterSeed,
          nowIso,
          nowIso
        ),
      env.DB
        .prepare(
          `INSERT INTO allowance_rules
            (base_amount_yen, bonus_interval_days, bonus_amount_yen,
             effective_from_utc, created_at_utc)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          baseAmountYen,
          bonusIntervalDays,
          bonusAmountYen,
          nowIso,
          nowIso
        )
    ]);
  } catch {
    throw new HttpError(409, "ALREADY_SETUP", "初期設定は完了しています。");
  }
  const rule = await getCurrentRule(env.DB, nowIso);
  requireRule(rule);
  return json(
    {
      familyKey,
      settings: { goalMinutes, updatedAt: nowIso },
      allowanceRule: mapRule(rule)
    },
    201
  );
}

async function handleToday(
  env: Env,
  settings: AppSettingsRow,
  now: Date
): Promise<Response> {
  const nowIso = now.toISOString();
  const today = localDateInTokyo(now);
  const [rule, achievement, currentStreakDays, total] = await Promise.all([
    getCurrentRule(env.DB, nowIso),
    env.DB
      .prepare(`${ACHIEVEMENT_WITH_PAID} WHERE a.local_date = ? LIMIT 1`)
      .bind(today)
      .first<AchievementRow>(),
    latestStreak(env.DB, today),
    env.DB
      .prepare("SELECT COUNT(*) AS count FROM achievements")
      .first<{ count: number }>()
  ]);
  requireRule(rule);
  return json({
    localDate: today,
    goalMinutes: settings.goal_minutes,
    currentStreakDays,
    achievement: achievement ? mapAchievement(achievement) : null,
    allowanceRule: mapRule(rule),
    character: calculateCharacterState(
      total?.count ?? 0,
      currentStreakDays,
      settings.character_seed
    ),
    notification: {
      enabled: Boolean(settings.notifications_enabled),
      time: settings.notification_time,
      available: Boolean(env.VAPID_PUBLIC_KEY),
      publicKey: env.VAPID_PUBLIC_KEY ?? null
    }
  });
}

function subscriptionValues(body: Record<string, unknown>): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  rejectUnknownKeys(body, ["endpoint", "p256dh", "auth"]);
  const endpoint = requiredString(body, "endpoint");
  const p256dh = requiredString(body, "p256dh");
  const auth = requiredString(body, "auth");
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "通知先が正しくありません。");
  }
  if (
    parsedEndpoint.protocol !== "https:" ||
    !PUSH_SERVICE_HOSTS.has(parsedEndpoint.hostname) ||
    endpoint.length > 2048 ||
    p256dh.length > 512 ||
    auth.length > 512
  ) {
    throw new HttpError(400, "INVALID_INPUT", "通知先が正しくありません。");
  }
  return { endpoint, p256dh, auth };
}

async function handlePushSubscriptionPost(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const values = subscriptionValues(await readJsonObject(request));
  const nowIso = now.toISOString();
  await env.DB
    .prepare(
      `INSERT INTO push_subscriptions
        (endpoint, p256dh, auth, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         updated_at_utc = excluded.updated_at_utc`
    )
    .bind(values.endpoint, values.p256dh, values.auth, nowIso, nowIso)
    .run();
  return empty();
}

async function handlePushSubscriptionDelete(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["endpoint"]);
  const endpoint = requiredString(body, "endpoint");
  await env.DB
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(endpoint)
    .run();
  return empty();
}

async function handleCreateAchievement(
  request: Request,
  env: Env,
  settings: AppSettingsRow,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["method", "subject", "note"]);
  const method = requiredString(body, "method");
  if (method !== "timer" && method !== "self_report") {
    throw new HttpError(400, "INVALID_INPUT", "methodが正しくありません。");
  }
  const subject = optionalTrimmedString(body, "subject", 20);
  const note = optionalTrimmedString(body, "note", 120);
  const today = localDateInTokyo(now);
  const existing = await env.DB
    .prepare(`${ACHIEVEMENT_WITH_PAID} WHERE a.local_date = ? LIMIT 1`)
    .bind(today)
    .first<AchievementRow>();
  if (existing) {
    return json({ created: false, achievement: mapAchievement(existing) });
  }

  const nowIso = now.toISOString();
  const [rule, previous] = await Promise.all([
    getCurrentRule(env.DB, nowIso),
    env.DB
      .prepare(
        `SELECT local_date, streak_days
         FROM achievements
         WHERE local_date = ?
         LIMIT 1`
      )
      .bind(addLocalDays(today, -1))
      .first<LatestStreakRow>()
  ]);
  requireRule(rule);
  const streakDays = calculateStreak(
    previous?.local_date ?? null,
    previous?.streak_days ?? null,
    today
  );
  const reward = calculateReward(
    streakDays,
    rule.base_amount_yen,
    rule.bonus_interval_days,
    rule.bonus_amount_yen
  );
  const id = crypto.randomUUID();
  try {
    await env.DB
      .prepare(
        `INSERT INTO achievements
          (id, local_date, method, subject, note, target_minutes, streak_days,
           base_amount_yen, bonus_amount_yen, total_amount_yen,
           allowance_rule_id, achieved_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        today,
        method,
        subject,
        note,
        settings.goal_minutes,
        streakDays,
        reward.baseAmountYen,
        reward.bonusAmountYen,
        reward.totalAmountYen,
        rule.id,
        nowIso
      )
      .run();
  } catch {
    const concurrent = await env.DB
      .prepare(`${ACHIEVEMENT_WITH_PAID} WHERE a.local_date = ? LIMIT 1`)
      .bind(today)
      .first<AchievementRow>();
    if (concurrent) {
      return json({ created: false, achievement: mapAchievement(concurrent) });
    }
    throw new HttpError(500, "CREATE_FAILED", "達成記録を保存できませんでした。");
  }
  const created = await env.DB
    .prepare(`${ACHIEVEMENT_WITH_PAID} WHERE a.id = ? LIMIT 1`)
    .bind(id)
    .first<AchievementRow>();
  if (!created) {
    throw new HttpError(500, "CREATE_FAILED", "達成記録を読み込めませんでした。");
  }
  return json({ created: true, achievement: mapAchievement(created) }, 201);
}

async function handleCalendar(url: URL, env: Env, now: Date): Promise<Response> {
  const month = url.searchParams.get("month");
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new HttpError(400, "INVALID_INPUT", "monthはYYYY-MMで指定してください。");
  }
  const today = localDateInTokyo(now);
  const { start, end } = mondayWeekRange(today);
  const [
    achievements,
    weekly,
    unpaid,
    currentStreakDays,
    total,
    settings
  ] = await Promise.all([
    env.DB
      .prepare(
        `${ACHIEVEMENT_WITH_PAID}
         WHERE substr(a.local_date, 1, 7) = ?
         ORDER BY a.local_date ASC`
      )
      .bind(month)
      .all<AchievementRow>(),
    env.DB
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount_yen), 0) AS amount
         FROM achievements
         WHERE local_date BETWEEN ? AND ?`
      )
      .bind(start, end)
      .first<{ count: number; amount: number }>(),
    env.DB
      .prepare(
        `SELECT COALESCE(SUM(total_amount_yen), 0) AS amount
         FROM unpaid_achievements`
      )
      .first<{ amount: number }>(),
    latestStreak(env.DB, today),
    env.DB
      .prepare("SELECT COUNT(*) AS count FROM achievements")
      .first<{ count: number }>(),
    getSettings(env.DB)
  ]);
  if (!settings) {
    throw new HttpError(409, "SETUP_REQUIRED", "初期設定が必要です。");
  }
  return json({
    month,
    currentStreakDays,
    weeklyAchievementCount: weekly?.count ?? 0,
    weeklyEarnedYen: weekly?.amount ?? 0,
    unpaidBalanceYen: unpaid?.amount ?? 0,
    achievements: achievements.results.map(mapAchievement),
    character: calculateCharacterState(
      total?.count ?? 0,
      currentStreakDays,
      settings.character_seed
    )
  });
}

async function handleGoalUpdate(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["goalMinutes"]);
  const goalMinutes = integerInRange(body, "goalMinutes", 5, 180);
  if (!isGoalMinutes(goalMinutes)) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "goalMinutesは5分刻みにしてください。"
    );
  }
  const nowIso = now.toISOString();
  await env.DB
    .prepare(
      `UPDATE app_settings
       SET goal_minutes = ?, updated_at_utc = ?
       WHERE id = 1`
    )
    .bind(goalMinutes, nowIso)
    .run();
  return json({ goalMinutes, updatedAt: nowIso });
}

async function handleParentSession(
  request: Request,
  env: Env,
  settings: AppSettingsRow,
  now: Date
): Promise<Response> {
  if (!env.PARENT_SESSION_SECRET) {
    throw new HttpError(500, "MISSING_SECRET", "親セッション用Secretが未設定です。");
  }
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["pin"]);
  const pin = requiredString(body, "pin", /^\d{4}$/);
  const nowIso = now.toISOString();
  const activeLock =
    settings.pin_locked_until_utc &&
    Date.parse(settings.pin_locked_until_utc) > now.getTime();
  if (activeLock) {
    throw new HttpError(
      429,
      "PIN_LOCKED",
      `${PIN_LOCK_MINUTES}分後にもう一度試してください。`
    );
  }
  if (!(await verifyPin(pin, settings.pin_hash))) {
    const lockedUntil = new Date(
      now.getTime() + PIN_LOCK_MINUTES * 60 * 1000
    ).toISOString();
    await env.DB
      .prepare(
        `UPDATE app_settings
         SET
           pin_failed_attempts = CASE
             WHEN pin_locked_until_utc IS NOT NULL
              AND pin_locked_until_utc <= ?
             THEN 1
             ELSE pin_failed_attempts + 1
           END,
           pin_locked_until_utc = CASE
             WHEN (
               CASE
                 WHEN pin_locked_until_utc IS NOT NULL
                  AND pin_locked_until_utc <= ?
                 THEN 1
                 ELSE pin_failed_attempts + 1
               END
             ) >= ? THEN ?
             ELSE NULL
           END,
           updated_at_utc = ?
         WHERE id = 1`
      )
      .bind(nowIso, nowIso, MAX_PIN_ATTEMPTS, lockedUntil, nowIso)
      .run();
    const updated = await getSettings(env.DB);
    if (
      updated?.pin_locked_until_utc &&
      Date.parse(updated.pin_locked_until_utc) > now.getTime()
    ) {
      throw new HttpError(
        429,
        "PIN_LOCKED",
        `${PIN_LOCK_MINUTES}分後にもう一度試してください。`
      );
    }
    throw new HttpError(403, "INVALID_PIN", "PINが正しくありません。");
  }
  if (settings.pin_failed_attempts > 0 || settings.pin_locked_until_utc) {
    await env.DB
      .prepare(
        `UPDATE app_settings
         SET
           pin_failed_attempts = 0,
           pin_locked_until_utc = NULL,
           updated_at_utc = ?
         WHERE id = 1`
      )
      .bind(now.toISOString())
      .run();
  }
  return json(await createParentSession(env.PARENT_SESSION_SECRET, now));
}

async function handleParentDashboard(env: Env, now: Date): Promise<Response> {
  const today = localDateInTokyo(now);
  const [aggregate, rule, currentStreakDays, settings] = await Promise.all([
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS count,
           COALESCE(SUM(total_amount_yen), 0) AS amount,
           MIN(local_date) AS oldest,
           MAX(local_date) AS newest
         FROM unpaid_achievements`
      )
      .first<AggregateRow>(),
    getCurrentRule(env.DB, now.toISOString()),
    latestStreak(env.DB, today),
    getSettings(env.DB)
  ]);
  requireRule(rule);
  if (!settings) {
    throw new HttpError(409, "SETUP_REQUIRED", "初期設定が必要です。");
  }
  return json({
    unpaidBalanceYen: aggregate?.amount ?? 0,
    unpaidAchievementCount: aggregate?.count ?? 0,
    currentStreakDays,
    oldestUnpaidDate: aggregate?.oldest ?? null,
    newestUnpaidDate: aggregate?.newest ?? null,
    currentAllowanceRule: mapRule(rule),
    notificationSettings: {
      enabled: Boolean(settings.notifications_enabled),
      time: settings.notification_time
    }
  });
}

async function handleNotificationSettingsUpdate(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["enabled", "time"]);
  if (typeof body.enabled !== "boolean" || typeof body.time !== "string") {
    throw new HttpError(400, "INVALID_INPUT", "通知設定が正しくありません。");
  }
  if (!isNotificationTime(body.time)) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "通知時刻は5分刻みで指定してください。"
    );
  }
  await env.DB
    .prepare(
      `UPDATE app_settings
       SET notifications_enabled = ?, notification_time = ?, updated_at_utc = ?
       WHERE id = 1`
    )
    .bind(body.enabled ? 1 : 0, body.time, now.toISOString())
    .run();
  return json({ enabled: body.enabled, time: body.time });
}

async function handleParentAchievements(url: URL, env: Env): Promise<Response> {
  const cursor = url.searchParams.get("cursor");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "INVALID_INPUT", "limitが正しくありません。");
  }
  const statement = cursor
    ? env.DB
        .prepare(
          `${ACHIEVEMENT_WITH_PAID}
           WHERE a.achieved_at_utc < ?
           ORDER BY a.achieved_at_utc DESC
           LIMIT ?`
        )
        .bind(cursor, limit)
    : env.DB
        .prepare(
          `${ACHIEVEMENT_WITH_PAID}
           ORDER BY a.achieved_at_utc DESC
           LIMIT ?`
        )
        .bind(limit);
  const rows = await statement.all<AchievementRow>();
  const last = rows.results.at(-1);
  return json({
    items: rows.results.map(mapAchievement),
    nextCursor: rows.results.length === limit && last ? last.achieved_at_utc : null
  });
}

async function handleRulesGet(env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT * FROM allowance_rules
       ORDER BY effective_from_utc DESC`
    )
    .all<AllowanceRuleRow>();
  return json({ items: rows.results.map(mapRule) });
}

async function handleRulesPost(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, [
    "baseAmountYen",
    "bonusIntervalDays",
    "bonusAmountYen"
  ]);
  const baseAmountYen = integerInRange(body, "baseAmountYen", 0, 100_000);
  const bonusIntervalDays = integerInRange(
    body,
    "bonusIntervalDays",
    1,
    365
  );
  const bonusAmountYen = integerInRange(
    body,
    "bonusAmountYen",
    0,
    100_000
  );
  const nowIso = now.toISOString();
  const result = await env.DB
    .prepare(
      `INSERT INTO allowance_rules
        (base_amount_yen, bonus_interval_days, bonus_amount_yen,
         effective_from_utc, created_at_utc)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      baseAmountYen,
      bonusIntervalDays,
      bonusAmountYen,
      nowIso,
      nowIso
    )
    .run();
  const rule = await env.DB
    .prepare("SELECT * FROM allowance_rules WHERE id = ?")
    .bind(result.meta.last_row_id)
    .first<AllowanceRuleRow>();
  requireRule(rule);
  return json(mapRule(rule), 201);
}

async function handlePaymentsGet(env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `${PAYMENT_WITH_COUNT}
       GROUP BY p.id
       ORDER BY p.paid_at_utc DESC`
    )
    .all<PaymentRow>();
  return json({ items: rows.results.map(mapPayment) });
}

async function paymentByIdempotency(
  env: Env,
  idempotencyKey: string
): Promise<PaymentRow | null> {
  return env.DB
    .prepare(
      `${PAYMENT_WITH_COUNT}
       WHERE p.idempotency_key = ?
       GROUP BY p.id
       LIMIT 1`
    )
    .bind(idempotencyKey)
    .first<PaymentRow>();
}

async function handleSettle(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (
    !idempotencyKey ||
    idempotencyKey.length < 16 ||
    idempotencyKey.length > 100
  ) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Keyが正しくありません。"
    );
  }
  const existing = await paymentByIdempotency(env, idempotencyKey);
  if (existing) {
    return json(mapPayment(existing));
  }
  const paymentId = crypto.randomUUID();
  const nowIso = now.toISOString();
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO payments
            (id, idempotency_key, amount_yen, paid_at_utc)
           VALUES (?, ?, 0, ?)`
        )
        .bind(paymentId, idempotencyKey, nowIso),
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO payment_achievements
            (payment_id, achievement_id)
           SELECT ?, id FROM unpaid_achievements`
        )
        .bind(paymentId),
      env.DB
        .prepare(
          `UPDATE payments
           SET
             amount_yen = COALESCE((
               SELECT SUM(a.total_amount_yen)
               FROM payment_achievements pa
               JOIN achievements a ON a.id = pa.achievement_id
               WHERE pa.payment_id = ?
             ), 0),
             period_start_date = (
               SELECT MIN(a.local_date)
               FROM payment_achievements pa
               JOIN achievements a ON a.id = pa.achievement_id
               WHERE pa.payment_id = ?
             ),
             period_end_date = (
               SELECT MAX(a.local_date)
               FROM payment_achievements pa
               JOIN achievements a ON a.id = pa.achievement_id
               WHERE pa.payment_id = ?
             )
           WHERE id = ?`
        )
        .bind(paymentId, paymentId, paymentId, paymentId),
      env.DB
        .prepare(
          `DELETE FROM payments
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM payment_achievements
               WHERE payment_id = ?
             )`
        )
        .bind(paymentId, paymentId)
    ]);
  } catch {
    const concurrent = await paymentByIdempotency(env, idempotencyKey);
    if (concurrent) {
      return json(mapPayment(concurrent));
    }
    throw new HttpError(500, "SETTLEMENT_FAILED", "支払いを記録できませんでした。");
  }
  const payment = await paymentByIdempotency(env, idempotencyKey);
  if (!payment) {
    throw new HttpError(
      409,
      "NO_UNPAID_ACHIEVEMENTS",
      "未払いの達成記録はありません。"
    );
  }
  return json(mapPayment(payment), 201);
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function handleExport(env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT
         a.local_date,
         a.method,
         a.subject,
         a.note,
         a.streak_days,
         a.base_amount_yen,
         a.bonus_amount_yen,
         a.total_amount_yen,
         p.paid_at_utc
       FROM achievements a
       LEFT JOIN payment_achievements pa ON pa.achievement_id = a.id
       LEFT JOIN payments p ON p.id = pa.payment_id
       ORDER BY a.local_date ASC`
    )
    .all<{
      local_date: string;
      method: string;
      subject: string | null;
      note: string | null;
      streak_days: number;
      base_amount_yen: number;
      bonus_amount_yen: number;
      total_amount_yen: number;
      paid_at_utc: string | null;
    }>();
  const header = [
    "日付",
    "記録方法",
    "科目",
    "メモ",
    "連続日数",
    "基本額",
    "ボーナス",
    "合計額",
    "支払日時"
  ];
  const lines = [
    header.map(csvCell).join(","),
    ...rows.results.map((row) =>
      [
        row.local_date,
        row.method === "timer" ? "タイマー" : "自己申告",
        row.subject,
        row.note,
        row.streak_days,
        row.base_amount_yen,
        row.bonus_amount_yen,
        row.total_amount_yen,
        row.paid_at_utc
      ]
        .map(csvCell)
        .join(",")
    )
  ];
  return csv(lines.join("\r\n"), "study-habit-export.csv");
}

async function handleRotateFamilyKey(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["familyKey"]);
  const suppliedFamilyKey = optionalTrimmedString(body, "familyKey", 64);
  if (suppliedFamilyKey && !FAMILY_KEY_PATTERN.test(suppliedFamilyKey)) {
    throw new HttpError(400, "INVALID_INPUT", "familyKeyが正しくありません。");
  }
  const familyKey = suppliedFamilyKey ?? generateFamilyKey();
  const familyKeyHash = await sha256Hex(familyKey);
  await env.DB
    .prepare(
      `UPDATE app_settings
       SET
         pending_family_key_hash = ?,
         pending_family_key_created_at_utc = ?,
         updated_at_utc = ?
       WHERE id = 1`
    )
    .bind(familyKeyHash, now.toISOString(), now.toISOString())
    .run();
  return json({ familyKey });
}

async function handleConfirmFamilyKey(
  request: Request,
  env: Env,
  settings: AppSettingsRow,
  now: Date
): Promise<Response> {
  if (!settings.pending_family_key_hash) {
    return empty();
  }
  if (!(await pendingFamilyKeyMatches(request, settings))) {
    throw new HttpError(
      409,
      "PENDING_FAMILY_KEY_REQUIRED",
      "新しい家族キーで確認してください。"
    );
  }
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE app_settings
         SET
           family_key_hash = pending_family_key_hash,
           pending_family_key_hash = NULL,
           pending_family_key_created_at_utc = NULL,
           updated_at_utc = ?
         WHERE id = 1`
      )
      .bind(now.toISOString()),
    env.DB.prepare("DELETE FROM push_subscriptions")
  ]);
  return empty();
}

async function handlePinUpdate(
  request: Request,
  env: Env,
  now: Date
): Promise<Response> {
  const body = await readJsonObject(request);
  rejectUnknownKeys(body, ["newPin"]);
  const newPin = requiredString(body, "newPin", /^\d{4}$/);
  const pinHash = await hashPin(newPin);
  await env.DB
    .prepare(
      `UPDATE app_settings
       SET
         pin_hash = ?,
         pin_failed_attempts = 0,
         pin_locked_until_utc = NULL,
         updated_at_utc = ?
       WHERE id = 1`
    )
    .bind(pinHash, now.toISOString())
    .run();
  return empty();
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizedPath(url);
  const method = request.method.toUpperCase();
  const now = new Date();

  if (path === "/setup" && method === "POST") {
    return handleSetup(request, env, now);
  }

  const settings = await getSettings(env.DB);
  if (!settings) {
    throw new HttpError(409, "SETUP_REQUIRED", "初期設定が必要です。");
  }
  await requireFamilyKey(request, settings);

  if (path.startsWith("/parent/") && path !== "/parent/session") {
    if (!env.PARENT_SESSION_SECRET) {
      throw new HttpError(500, "MISSING_SECRET", "親セッション用Secretが未設定です。");
    }
    await requireValidParentSession(
      request,
      env.PARENT_SESSION_SECRET,
      now
    );
  }

  if (path === "/today" && method === "GET") {
    return handleToday(env, settings, now);
  }
  if (path === "/achievements" && method === "POST") {
    return handleCreateAchievement(request, env, settings, now);
  }
  if (path === "/calendar" && method === "GET") {
    return handleCalendar(url, env, now);
  }
  if (path === "/settings/goal" && method === "PATCH") {
    return handleGoalUpdate(request, env, now);
  }
  if (path === "/push/subscriptions" && method === "POST") {
    return handlePushSubscriptionPost(request, env, now);
  }
  if (path === "/push/subscriptions" && method === "DELETE") {
    return handlePushSubscriptionDelete(request, env);
  }
  if (path === "/parent/session" && method === "POST") {
    return handleParentSession(request, env, settings, now);
  }
  if (path === "/parent/dashboard" && method === "GET") {
    return handleParentDashboard(env, now);
  }
  if (path === "/parent/achievements" && method === "GET") {
    return handleParentAchievements(url, env);
  }
  if (path === "/parent/allowance-rules" && method === "GET") {
    return handleRulesGet(env);
  }
  if (path === "/parent/allowance-rules" && method === "POST") {
    return handleRulesPost(request, env, now);
  }
  if (path === "/parent/notifications" && method === "PATCH") {
    return handleNotificationSettingsUpdate(request, env, now);
  }
  if (path === "/parent/payments" && method === "GET") {
    return handlePaymentsGet(env);
  }
  if (path === "/parent/payments/settle" && method === "POST") {
    return handleSettle(request, env, now);
  }
  if (path === "/parent/export.csv" && method === "GET") {
    return handleExport(env);
  }
  if (path === "/parent/family-key/rotate" && method === "POST") {
    return handleRotateFamilyKey(request, env, now);
  }
  if (path === "/parent/family-key/confirm" && method === "POST") {
    return handleConfirmFamilyKey(request, env, settings, now);
  }
  if (path === "/parent/pin" && method === "PATCH") {
    return handlePinUpdate(request, env, now);
  }
  throw new HttpError(404, "NOT_FOUND", "APIが見つかりません。");
}
