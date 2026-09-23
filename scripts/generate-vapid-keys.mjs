import { generateKeyPairSync } from "node:crypto";

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

console.log(`VAPID_PUBLIC_KEY=${publicBytes.toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`);
console.log("VAPID_SUBJECT=mailto:your-email@example.com");
