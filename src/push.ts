import { api } from "./api";

const SERVICE_WORKER_TIMEOUT_MS = 15_000;
const SERVICE_WORKER_TIMEOUT_MESSAGE =
  "通知の準備が完了しませんでした。ページを再読み込みして、もう一度お試しください。";

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

export async function disablePushNotifications(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) {
    return;
  }
  await subscription.unsubscribe();
  await api.deletePushSubscription(subscription.endpoint);
}
