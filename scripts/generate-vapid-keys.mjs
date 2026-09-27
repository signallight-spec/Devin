import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256"
});
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });

if (!privateJwk.d || !publicJwk.x || !publicJwk.y) {
  throw new Error("VAPID鍵を生成できませんでした。");
}

const publicBytes = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicJwk.x, "base64url"),
  Buffer.from(publicJwk.y, "base64url")
]);

const envPath = resolve(process.env.VAPID_ENV_FILE ?? ".dev.vars");
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const currentPrivateKey = existing.match(/^VAPID_PRIVATE_KEY=(.+)$/m)?.[1];
if (
  currentPrivateKey &&
  currentPrivateKey !== "replace-with-generated-private-key"
) {
  throw new Error(
    `${envPath} にはVAPID秘密鍵が保存済みです。既存の端末登録を守るため再生成しません。`
  );
}

function setEnvValue(contents, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${line}\n`;
}

let next = existing;
next = setEnvValue(
  next,
  "VAPID_PUBLIC_KEY",
  publicBytes.toString("base64url")
);
next = setEnvValue(next, "VAPID_PRIVATE_KEY", privateJwk.d);
if (!/^VAPID_SUBJECT=/m.test(next)) {
  next = setEnvValue(
    next,
    "VAPID_SUBJECT",
    "mailto:your-email@example.com"
  );
}

writeFileSync(envPath, next, { encoding: "utf8", mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`VAPID鍵を ${envPath} に保存しました。秘密鍵は表示しません。`);
