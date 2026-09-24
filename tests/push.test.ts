/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn()
}));

vi.mock("../src/api", () => ({
  ApiError: class ApiError extends Error {
    readonly status = 401;
  },
  api: {
    savePushSubscription: apiMocks.savePushSubscription,
    deletePushSubscription: apiMocks.deletePushSubscription
  }
}));

import {
  disablePushNotifications,
  disconnectPushBeforeFamilyKeyRemoval,
  enablePushNotifications
} from "../src/push";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

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
  vi.stubGlobal("localStorage", memoryStorage());
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

  it("通常の通知解除ではブラウザ購読を先に無効化する", async () => {
    const subscription = pushSubscription();
    vi.mocked(subscription.unsubscribe).mockResolvedValue(true);
    const registered = registration(subscription, {} as ServiceWorker);
    vi.mocked(registered.pushManager.getSubscription).mockResolvedValue(
      subscription
    );
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(registered),
        register: vi.fn(),
        ready: Promise.resolve(registered)
      }
    });
    apiMocks.deletePushSubscription.mockRejectedValueOnce(
      new TypeError("network failure")
    );

    await expect(disablePushNotifications()).rejects.toThrow("network failure");
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(
      vi.mocked(subscription.unsubscribe).mock.invocationCallOrder[0]
    ).toBeLessThan(apiMocks.deletePushSubscription.mock.invocationCallOrder[0]);
    await expect(disablePushNotifications()).resolves.toBeUndefined();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(apiMocks.deletePushSubscription).toHaveBeenCalledTimes(2);
    expect(localStorage.length).toBe(0);
  });

  it("家族キー削除時のサーバー解除失敗を同じ通知先で再試行する", async () => {
    const subscription = pushSubscription();
    vi.mocked(subscription.unsubscribe).mockResolvedValue(true);
    const registered = registration(subscription, {} as ServiceWorker);
    vi.mocked(registered.pushManager.getSubscription).mockResolvedValue(
      subscription
    );
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue(registered),
      register: vi.fn(),
      ready: Promise.resolve(registered)
    };
    vi.stubGlobal("navigator", { serviceWorker });
    apiMocks.deletePushSubscription
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockResolvedValueOnce(undefined);

    await expect(disconnectPushBeforeFamilyKeyRemoval()).rejects.toThrow(
      "network failure"
    );
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    await expect(disconnectPushBeforeFamilyKeyRemoval()).resolves.toBeUndefined();
    expect(apiMocks.deletePushSubscription).toHaveBeenCalledTimes(2);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
  });
});
