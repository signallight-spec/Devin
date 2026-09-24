/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn()
}));

vi.mock("../src/api", () => ({
  api: {
    savePushSubscription: apiMocks.savePushSubscription,
    deletePushSubscription: apiMocks.deletePushSubscription
  }
}));

import { enablePushNotifications } from "../src/push";

function pushSubscription(): PushSubscription {
  return {
    endpoint: "https://jmt17.google.com/fcm/send/subscription-id",
    expirationTime: null,
    options: {} as PushSubscriptionOptions,
    getKey: vi.fn(),
    unsubscribe: vi.fn(),
    toJSON: () => ({
      endpoint: "https://jmt17.google.com/fcm/send/subscription-id",
      keys: {
        p256dh: "client-public-key",
        auth: "auth-secret"
      }
    })
  };
}

function registration(
  subscription: PushSubscription,
  active: ServiceWorker | null
): ServiceWorkerRegistration {
  return {
    active,
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(subscription)
    }
  } as unknown as ServiceWorkerRegistration;
}

beforeEach(() => {
  apiMocks.savePushSubscription.mockReset().mockResolvedValue(undefined);
  apiMocks.deletePushSubscription.mockReset().mockResolvedValue(undefined);
  const notification = {
    requestPermission: vi.fn().mockResolvedValue("granted")
  };
  const pushManager = class {};
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("PushManager", pushManager);
  vi.stubGlobal("window", {
    Notification: notification,
    PushManager: pushManager
  });
  vi.stubGlobal("atob", (value: string) => Buffer.from(value, "base64").toString("binary"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Push通知", () => {
  it("登録がなければService Workerを再登録して購読を保存する", async () => {
    const subscription = pushSubscription();
    const registered = registration(subscription, {} as ServiceWorker);
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(registered),
      ready: new Promise<ServiceWorkerRegistration>(() => {})
    };
    vi.stubGlobal("navigator", { serviceWorker });

    await enablePushNotifications("AQ");

    expect(serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(registered.pushManager.subscribe).toHaveBeenCalledOnce();
    expect(apiMocks.savePushSubscription).toHaveBeenCalledWith({
      endpoint: subscription.endpoint,
      p256dh: "client-public-key",
      auth: "auth-secret"
    });
  });

  it("Service Workerが準備できなければ待機を打ち切る", async () => {
    vi.useFakeTimers();
    const pendingRegistration = registration(pushSubscription(), null);
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue(pendingRegistration),
      register: vi.fn(),
      ready: new Promise<ServiceWorkerRegistration>(() => {})
    };
    vi.stubGlobal("navigator", { serviceWorker });

    const rejection = expect(enablePushNotifications("AQ")).rejects.toThrow(
      "通知の準備が完了しませんでした。ページを再読み込みして、もう一度お試しください。"
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(apiMocks.savePushSubscription).not.toHaveBeenCalled();
  });
});
