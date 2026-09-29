import {
  buildPushPayload,
  type PushSubscription
} from "@block65/webcrypto-web-push";
import { notificationDue } from "./reminder";

interface NotificationEnv {
  DB: D1Database;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

interface NotificationSettingsRow {
  notifications_enabled: number;
  notification_time: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string;
  updated_at_utc: string;
}

async function buildNotificationPayload(
  subscription: SubscriptionRow,
  env: NotificationEnv
): Promise<RequestInit> {
  const pushSubscription: PushSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth
    }
  };
  return buildPushPayload(
    {
      data: JSON.stringify({
        title: "今日の学習はまだです",
        body: "少しだけでも始めて、育てている仲間に会いにいこう。",
        url: "/"
      }),
      options: {
        ttl: 3600,
        urgency: "normal"
      }
    },
    pushSubscription,
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    }
  );
}

async function claimSubscription(
  env: NotificationEnv,
  localDate: string,
  deviceId: string,
  endpoint: string,
  now: Date
): Promise<string | null> {
  const nowIso = now.toISOString();
  const claimToken = crypto.randomUUID();
  const inserted = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO notification_delivery_subscriptions
        (local_date, device_id, endpoint, sent_at_utc, status, claim_token)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .bind(localDate, deviceId, endpoint, nowIso, claimToken)
    .run();
  if (inserted.meta.changes) {
    return claimToken;
  }
  const reclaimed = await env.DB
    .prepare(
      `UPDATE notification_delivery_subscriptions
       SET endpoint = ?, status = 'pending', sent_at_utc = ?, claim_token = ?
       WHERE local_date = ?
        AND device_id = ?
        AND status = 'failed'`
    )
    .bind(endpoint, nowIso, claimToken, localDate, deviceId)
    .run();
  return reclaimed.meta.changes ? claimToken : null;
}

async function markSubscriptionResult(
  env: NotificationEnv,
  localDate: string,
  deviceId: string,
  claimToken: string,
  status: "sent" | "failed",
  now: Date
): Promise<boolean> {
  const result = await env.DB
    .prepare(
      `UPDATE notification_delivery_subscriptions
       SET status = ?, sent_at_utc = ?
       WHERE local_date = ?
        AND device_id = ?
        AND status = 'pending'
        AND claim_token = ?`
    )
    .bind(status, now.toISOString(), localDate, deviceId, claimToken)
    .run();
  return Boolean(result.meta.changes);
}

async function releaseSubscriptionClaim(
  env: NotificationEnv,
  localDate: string,
  deviceId: string,
  claimToken: string
): Promise<void> {
  await env.DB
    .prepare(
      `DELETE FROM notification_delivery_subscriptions
       WHERE local_date = ?
        AND device_id = ?
        AND status = 'pending'
        AND claim_token = ?`
    )
    .bind(localDate, deviceId, claimToken)
    .run();
}

async function markSubscriptionFailedOrRelease(
  env: NotificationEnv,
  localDate: string,
  deviceId: string,
  claimToken: string,
  now: Date
): Promise<void> {
  try {
    await markSubscriptionResult(
      env,
      localDate,
      deviceId,
      claimToken,
      "failed",
      now
    );
  } catch {
    await releaseSubscriptionClaim(env, localDate, deviceId, claimToken);
  }
}

async function achievementExists(
  env: NotificationEnv,
  localDate: string
): Promise<boolean> {
  const achievement = await env.DB
    .prepare("SELECT id FROM achievements WHERE local_date = ?")
    .bind(localDate)
    .first<{ id: string }>();
  return Boolean(achievement);
}

async function notificationStillDue(
  env: NotificationEnv,
  localDate: string,
  now: Date
): Promise<boolean> {
  const settings = await env.DB
    .prepare(
      `SELECT notifications_enabled, notification_time
       FROM app_settings
       WHERE id = 1`
    )
    .first<NotificationSettingsRow>();
  if (!settings) {
    return false;
  }
  const timing = notificationDue(
    Boolean(settings.notifications_enabled),
    settings.notification_time,
    now
  );
  return timing.due && timing.localDate === localDate;
}

export async function processReminder(
  env: NotificationEnv,
  now = new Date(),
  currentTime: () => Date = () => now
): Promise<number> {
  const settings = await env.DB
    .prepare(
      `SELECT notifications_enabled, notification_time
       FROM app_settings
       WHERE id = 1`
    )
    .first<NotificationSettingsRow>();
  if (!settings) {
    return 0;
  }
  const timing = notificationDue(
    Boolean(settings.notifications_enabled),
    settings.notification_time,
    now
  );
  if (!timing.due) {
    return 0;
  }
  if (await achievementExists(env, timing.localDate)) {
    return 0;
  }
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries
        (local_date, claimed_at_utc, sent_count)
       VALUES (?, ?, 0)`
    )
    .bind(timing.localDate, now.toISOString())
    .run();
  const subscriptions = await env.DB
    .prepare(
      `SELECT endpoint, p256dh, auth, device_id, updated_at_utc
       FROM push_subscriptions
       WHERE device_id IS NOT NULL`
    )
    .all<SubscriptionRow>();
  if (subscriptions.results.length === 0) {
    return 0;
  }

  let sentCount = 0;
  await Promise.all(
    subscriptions.results.map(async (subscription) => {
      const claimToken = await claimSubscription(
        env,
        timing.localDate,
        subscription.device_id,
        subscription.endpoint,
        now
      );
      if (!claimToken) {
        return;
      }
      if (await achievementExists(env, timing.localDate)) {
        await releaseSubscriptionClaim(
          env,
          timing.localDate,
          subscription.device_id,
          claimToken
        );
        return;
      }
      if (
        !(await notificationStillDue(
          env,
          timing.localDate,
          currentTime()
        ))
      ) {
        await releaseSubscriptionClaim(
          env,
          timing.localDate,
          subscription.device_id,
          claimToken
        );
        return;
      }
      let payload: RequestInit;
      try {
        payload = await buildNotificationPayload(subscription, env);
      } catch {
        await releaseSubscriptionClaim(
          env,
          timing.localDate,
          subscription.device_id,
          claimToken
        );
        return;
      }
      if (
        await achievementExists(env, timing.localDate) ||
        !(await notificationStillDue(
          env,
          timing.localDate,
          currentTime()
        ))
      ) {
        await releaseSubscriptionClaim(
          env,
          timing.localDate,
          subscription.device_id,
          claimToken
        );
        return;
      }
      let response: Response;
      try {
        response = await fetch(subscription.endpoint, {
          ...payload,
          redirect: "manual"
        });
      } catch {
        return;
      }
      if (response.ok) {
        try {
          const marked = await markSubscriptionResult(
            env,
            timing.localDate,
            subscription.device_id,
            claimToken,
            "sent",
            now
          );
          if (marked) {
            sentCount += 1;
            await env.DB
              .prepare(
                `UPDATE push_subscriptions
                 SET last_success_at_utc = ?
                 WHERE endpoint = ?
                  AND device_id = ?
                  AND p256dh = ?
                  AND auth = ?
                  AND updated_at_utc = ?`
              )
              .bind(
                now.toISOString(),
                subscription.endpoint,
                subscription.device_id,
                subscription.p256dh,
                subscription.auth,
                subscription.updated_at_utc
              )
              .run();
          }
        } catch {
          return;
        }
        return;
      }
      if (response.status === 404 || response.status === 410) {
        await env.DB
          .prepare(
            `DELETE FROM push_subscriptions
             WHERE endpoint = ?
              AND device_id = ?
              AND p256dh = ?
              AND auth = ?
              AND updated_at_utc = ?`
          )
          .bind(
            subscription.endpoint,
            subscription.device_id,
            subscription.p256dh,
            subscription.auth,
            subscription.updated_at_utc
          )
          .run()
          .catch(() => undefined);
      }
      await markSubscriptionFailedOrRelease(
        env,
        timing.localDate,
        subscription.device_id,
        claimToken,
        now
      );
    })
  );
  await env.DB
    .prepare(
      `UPDATE notification_deliveries
       SET sent_count = (
         SELECT COUNT(*)
         FROM notification_delivery_subscriptions
         WHERE local_date = ?
          AND status = 'sent'
       )
       WHERE local_date = ?`
    )
    .bind(timing.localDate, timing.localDate)
    .run();
  return sentCount;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: NotificationEnv,
    context: ExecutionContext
  ): Promise<void> {
    void controller;
    context.waitUntil(processReminder(env, new Date(), () => new Date()));
  }
};
