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
  const subscriptions = await env.DB
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    .all<SubscriptionRow>();
  if (subscriptions.results.length === 0) {
    return 0;
  }
  const claim = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries
        (local_date, claimed_at_utc, sent_count)
       VALUES (?, ?, 0)`
    )
    .bind(timing.localDate, now.toISOString())
    .run();
  if (!claim.meta.changes) {
    return 0;
  }

  let sentCount = 0;
  await Promise.all(
    subscriptions.results.map(async (subscription) => {
      try {
        const response = await sendNotification(subscription, env);
        if (response.ok) {
          sentCount += 1;
          await env.DB
            .prepare(
              `UPDATE push_subscriptions
               SET last_success_at_utc = ?
               WHERE endpoint = ?`
            )
            .bind(now.toISOString(), subscription.endpoint)
            .run();
          return;
        }
        if (response.status === 404 || response.status === 410) {
          await env.DB
            .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .bind(subscription.endpoint)
            .run();
        }
      } catch {
        return;
      }
    })
  );
  await env.DB
    .prepare(
      `UPDATE notification_deliveries
       SET sent_count = ?
       WHERE local_date = ?`
    )
    .bind(sentCount, timing.localDate)
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
