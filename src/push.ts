import { api, ApiError } from "./api";

const SERVICE_WORKER_TIMEOUT_MS = 15_000;
const SERVICE_WORKER_TIMEOUT_MESSAGE =
  "通知の準備が完了しませんでした。ページを再読み込みして、もう一度お試しください。";
const PENDING_PUSH_DELETION_STORAGE = "study-habit-pending-push-deletion";

interface PendingPushDeletion {
  endpoint: string;
  browserUnsubscribed: boolean;
}

function pendingPushDeletion(): PendingPushDeletion | null {
  const stored = localStorage.getItem(PENDING_PUSH_DELETION_STORAGE);
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<PendingPushDeletion>;
    if (
      typeof parsed.endpoint === "string" &&
      typeof parsed.browserUnsubscribed === "boolean"
    ) {
      return {
        endpoint: parsed.endpoint,
        browserUnsubscribed: parsed.browserUnsubscribed
      };
    }
  } catch {
    return { endpoint: stored, browserUnsubscribed: true };
  }
  localStorage.removeItem(PENDING_PUSH_DELETION_STORAGE);
  return null;
}

function savePendingPushDeletion(value: PendingPushDeletion): void {
  localStorage.setItem(PENDING_PUSH_DELETION_STORAGE, JSON.stringify(value));
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function subscriptionInput(subscription: PushSubscription): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("通知端末を登録できませんでした。");
  }
  return {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth
  };
}

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  const serviceWorker = navigator.serviceWorker;
  const registrationPromise = (async () => {
    const existing = await serviceWorker.getRegistration("/");
    const registration = existing ?? await serviceWorker.register("/sw.js");
    if (registration.active) {
      return registration;
    }
    return serviceWorker.ready;
  })();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(SERVICE_WORKER_TIMEOUT_MESSAGE)),
      SERVICE_WORKER_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([registrationPromise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const registration = await pushRegistration();
  return registration.pushManager.getSubscription();
}

async function existingPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.pushManager.getSubscription() ?? null;
}

export async function syncPushSubscription(
  subscription: PushSubscription
): Promise<void> {
  await api.savePushSubscription(subscriptionInput(subscription));
}

export async function enablePushNotifications(
  publicKey: string
): Promise<void> {
  if (!pushSupported()) {
    throw new Error("このブラウザは通知に対応していません。");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Androidの設定で通知を許可してください。");
  }
  const registration = await pushRegistration();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey)
  });
  await syncPushSubscription(subscription);
}

async function removePushSubscription(
  ignoreUnauthorized: boolean,
  findSubscription: () => Promise<PushSubscription | null>
): Promise<void> {
  let pending = pendingPushDeletion();
  if (!pending) {
    const subscription = await findSubscription();
    if (!subscription) {
      return;
    }
    pending = {
      endpoint: subscription.endpoint,
      browserUnsubscribed: false
    };
    savePendingPushDeletion(pending);
    if (await subscription.unsubscribe() === false) {
      throw new Error("この端末の通知購読を解除できませんでした。もう一度お試しください。");
    }
    pending = { ...pending, browserUnsubscribed: true };
    savePendingPushDeletion(pending);
  } else if (!pending.browserUnsubscribed) {
    const subscription = await findSubscription();
    if (
      subscription?.endpoint === pending.endpoint &&
      await subscription.unsubscribe() === false
    ) {
      throw new Error("この端末の通知購読を解除できませんでした。もう一度お試しください。");
    }
    pending = { ...pending, browserUnsubscribed: true };
    savePendingPushDeletion(pending);
  }
  try {
    await api.deletePushSubscription(pending.endpoint);
  } catch (error) {
    if (!(ignoreUnauthorized && error instanceof ApiError && error.status === 401)) {
      throw error;
    }
  }
  localStorage.removeItem(PENDING_PUSH_DELETION_STORAGE);
}

export async function disablePushNotifications(): Promise<void> {
  await removePushSubscription(false, currentPushSubscription);
}

export async function disconnectPushBeforeFamilyKeyRemoval(): Promise<void> {
  await removePushSubscription(true, existingPushSubscription);
}
