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
}

const CLAIM_STALE_MINUTES = 15;

async function sendNotification(
  subscription: SubscriptionRow,
  env: NotificationEnv
): Promise<Response> {
  const pushSubscription: PushSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth
    }
  };
  const payload = await buildPushPayload(
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
  return fetch(subscription.endpoint, payload);
}

async function claimSubscription(
  env: NotificationEnv,
  localDate: string,
  endpoint: string,
  now: Date
): Promise<boolean> {
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(
    now.getTime() - CLAIM_STALE_MINUTES * 60 * 1000
  ).toISOString();
  const inserted = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO notification_delivery_subscriptions
        (local_date, endpoint, sent_at_utc, status)
       VALUES (?, ?, ?, 'pending')`
    )
    .bind(localDate, endpoint, nowIso)
    .run();
  if (inserted.meta.changes) {
    return true;
  }
  const reclaimed = await env.DB
    .prepare(
      `UPDATE notification_delivery_subscriptions
       SET status = 'pending', sent_at_utc = ?
       WHERE local_date = ?
        AND endpoint = ?
        AND status != 'sent'
        AND (
          status = 'failed'
          OR sent_at_utc <= ?
        )`
    )
    .bind(nowIso, localDate, endpoint, staleBeforeIso)
    .run();
  return Boolean(reclaimed.meta.changes);
}

async function markSubscriptionResult(
  env: NotificationEnv,
  localDate: string,
  endpoint: string,
  status: "sent" | "failed",
  now: Date
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE notification_delivery_subscriptions
       SET status = ?, sent_at_utc = ?
       WHERE local_date = ?
        AND endpoint = ?
        AND status = 'pending'`
    )
    .bind(status, now.toISOString(), localDate, endpoint)
    .run();
}

export async function processReminder(
  env: NotificationEnv,
  now = new Date()
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
  const achievement = await env.DB
    .prepare("SELECT id FROM achievements WHERE local_date = ?")
    .bind(timing.localDate)
    .first<{ id: number }>();
  if (achievement) {
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
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    .all<SubscriptionRow>();
  if (subscriptions.results.length === 0) {
    return 0;
  }

  let sentCount = 0;
  await Promise.all(
    subscriptions.results.map(async (subscription) => {
      const claimed = await claimSubscription(
        env,
        timing.localDate,
        subscription.endpoint,
        now
      );
      if (!claimed) {
        return;
      }
      try {
        const response = await sendNotification(subscription, env);
        if (response.ok) {
          sentCount += 1;
          await env.DB.batch([
            env.DB
              .prepare(
                `UPDATE notification_delivery_subscriptions
                 SET status = 'sent', sent_at_utc = ?
                 WHERE local_date = ?
                  AND endpoint = ?
                  AND status = 'pending'`
              )
              .bind(now.toISOString(), timing.localDate, subscription.endpoint),
            env.DB
              .prepare(
                `UPDATE push_subscriptions
                 SET last_success_at_utc = ?
                 WHERE endpoint = ?`
              )
              .bind(now.toISOString(), subscription.endpoint)
          ]);
          return;
        }
        if (response.status === 404 || response.status === 410) {
          await env.DB
            .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .bind(subscription.endpoint)
            .run();
          return;
        }
        await markSubscriptionResult(
          env,
          timing.localDate,
          subscription.endpoint,
          "failed",
          now
        );
      } catch {
        await markSubscriptionResult(
          env,
          timing.localDate,
          subscription.endpoint,
          "failed",
          now
        );
        return;
      }
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
    context.waitUntil(processReminder(env, new Date(controller.scheduledTime)));
  }
};
