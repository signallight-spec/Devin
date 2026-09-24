const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export function empty(status = 204): Response {
  return new Response(null, { status, headers: SECURITY_HEADERS });
}

export function csv(content: string, fileName: string): Response {
  return new Response(`\uFEFF${content}`, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`
    }
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.status
    );
  }
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "処理に失敗しました。時間をおいて再試行してください。"
      }
    },
    500
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const maxBytes = 4096;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "入力が大きすぎます。");
  }
  if (!request.body) {
    throw new HttpError(400, "INVALID_JSON", "JSONの形式が正しくありません。");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "REQUEST_TOO_LARGE", "入力が大きすぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSONの形式が正しくありません。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_INPUT", "入力の形式が正しくありません。");
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      `未対応の入力項目があります: ${unexpected}`
    );
  }
}

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  pattern?: RegExp
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    (pattern && !pattern.test(candidate))
  ) {
    throw new HttpError(400, "INVALID_INPUT", `${key}が正しくありません。`);
  }
  return candidate;
}

export function optionalTrimmedString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number
): string | null {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    return null;
  }
  if (typeof candidate !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${key}が正しくありません。`);
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      `${key}は${maxLength}文字以内にしてください。`
    );
  }
  return trimmed;
}

export function integerInRange(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback?: number
): number {
  const candidate = value[key] ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new HttpError(400, "INVALID_INPUT", `${key}が正しくありません。`);
  }
  return candidate;
}
