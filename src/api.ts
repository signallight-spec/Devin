import type {
  Achievement,
  AllowanceRule,
  CalendarData,
  ParentDashboard,
  Payment,
  Today
} from "./types";

const FAMILY_KEY_STORAGE = "study-habit-family-key";
const PARENT_TOKEN_STORAGE = "study-habit-parent-token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function getFamilyKey(): string {
  return localStorage.getItem(FAMILY_KEY_STORAGE) ?? "";
}

export function setFamilyKey(value: string): void {
  localStorage.setItem(FAMILY_KEY_STORAGE, value);
}

export function generateFamilyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function clearFamilyKey(): void {
  localStorage.removeItem(FAMILY_KEY_STORAGE);
  sessionStorage.removeItem(PARENT_TOKEN_STORAGE);
}

export function getParentToken(): string {
  return sessionStorage.getItem(PARENT_TOKEN_STORAGE) ?? "";
}

export function setParentToken(value: string): void {
  sessionStorage.setItem(PARENT_TOKEN_STORAGE, value);
}

export function clearParentToken(): void {
  sessionStorage.removeItem(PARENT_TOKEN_STORAGE);
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  options: { parent?: boolean; familyKey?: string; bootstrapToken?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }
  const familyKey = options.familyKey ?? getFamilyKey();
  if (familyKey) {
    headers.set("X-Family-Key", familyKey);
  }
  if (options.parent) {
    const token = getParentToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  if (options.bootstrapToken) {
    headers.set("X-Bootstrap-Token", options.bootstrapToken);
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? "通信に失敗しました。"
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  setup(input: {
    bootstrapToken: string;
    familyKey: string;
    pin: string;
    goalMinutes: number;
    baseAmountYen: number;
    bonusIntervalDays: number;
    bonusAmountYen: number;
  }) {
    const { bootstrapToken, ...body } = input;
    return apiRequest<{
      familyKey: string;
      settings: { goalMinutes: number; updatedAt: string };
      allowanceRule: AllowanceRule;
    }>(
      "/setup",
      { method: "POST", body: JSON.stringify(body) },
      { bootstrapToken }
    );
  },
  today() {
    return apiRequest<Today>("/today");
  },
  validateFamilyKey(familyKey: string) {
    return apiRequest<Today>("/today", {}, { familyKey });
  },
  createAchievement(input: {
    method: "timer" | "self_report";
    subject: string | null;
    note: string | null;
  }) {
    return apiRequest<{ created: boolean; achievement: Achievement }>(
      "/achievements",
      { method: "POST", body: JSON.stringify(input) }
    );
  },
  calendar(month: string) {
    return apiRequest<CalendarData>(`/calendar?month=${encodeURIComponent(month)}`);
  },
  updateGoal(goalMinutes: number) {
    return apiRequest<{ goalMinutes: number; updatedAt: string }>(
      "/settings/goal",
      { method: "PATCH", body: JSON.stringify({ goalMinutes }) }
    );
  },
  savePushSubscription(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
  }) {
    return apiRequest<void>("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  deletePushSubscription(endpoint: string) {
    return apiRequest<void>("/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint })
    });
  },
  async startParentSession(pin: string) {
    const result = await apiRequest<{ token: string; expiresAt: string }>(
      "/parent/session",
      { method: "POST", body: JSON.stringify({ pin }) }
    );
    setParentToken(result.token);
    return result;
  },
  parentDashboard() {
    return apiRequest<ParentDashboard>("/parent/dashboard", {}, { parent: true });
  },
  parentAchievements() {
    return apiRequest<{ items: Achievement[]; nextCursor: string | null }>(
      "/parent/achievements?limit=100",
      {},
      { parent: true }
    );
  },
  rules() {
    return apiRequest<{ items: AllowanceRule[] }>(
      "/parent/allowance-rules",
      {},
      { parent: true }
    );
  },
  createRule(input: {
    baseAmountYen: number;
    bonusIntervalDays: number;
    bonusAmountYen: number;
  }) {
    return apiRequest<AllowanceRule>(
      "/parent/allowance-rules",
      { method: "POST", body: JSON.stringify(input) },
      { parent: true }
    );
  },
  updateNotificationSettings(input: { enabled: boolean; time: string }) {
    return apiRequest<{ enabled: boolean; time: string }>(
      "/parent/notifications",
      { method: "PATCH", body: JSON.stringify(input) },
      { parent: true }
    );
  },
  payments() {
    return apiRequest<{ items: Payment[] }>(
      "/parent/payments",
      {},
      { parent: true }
    );
  },
  settle() {
    return apiRequest<Payment>(
      "/parent/payments/settle",
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }
      },
      { parent: true }
    );
  },
  rotateFamilyKey(familyKey: string, currentFamilyKey: string) {
    return apiRequest<{ familyKey: string }>(
      "/parent/family-key/rotate",
      { method: "POST", body: JSON.stringify({ familyKey }) },
      { parent: true, familyKey: currentFamilyKey }
    );
  },
  confirmFamilyKey(familyKey: string) {
    return apiRequest<void>(
      "/parent/family-key/confirm",
      { method: "POST" },
      { parent: true, familyKey }
    );
  },
  updatePin(newPin: string) {
    return apiRequest<void>(
      "/parent/pin",
      { method: "PATCH", body: JSON.stringify({ newPin }) },
      { parent: true }
    );
  },
  async exportCsv(): Promise<void> {
    const response = await fetch("/api/parent/export.csv", {
      headers: {
        "X-Family-Key": getFamilyKey(),
        Authorization: `Bearer ${getParentToken()}`
      }
    });
    if (!response.ok) {
      throw new ApiError(response.status, "EXPORT_FAILED", "CSV出力に失敗しました。");
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "study-habit-export.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
};
