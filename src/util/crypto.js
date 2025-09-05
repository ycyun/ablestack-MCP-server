import crypto from "node:crypto";

export function hmac(algo, secret, data) {
  return crypto.createHmac(algo, secret).update(data).digest("base64");
}

