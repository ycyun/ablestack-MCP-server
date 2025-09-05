import { getConfig } from "../util/config.js";
import { hmac } from "../util/crypto.js";

function assertEnv() {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.apiKey || !cfg.secret) {
    throw new Error(
      "MOLD 연결정보가 없습니다. mold_setConfig 도구로 endpoint/apiKey/secret 을 설정하세요."
    );
  }
}

export function buildSignedUrl(params) {
  assertEnv();
  const cfg = getConfig();

  const baseParams = { response: "json", ...params, apiKey: cfg.apiKey };

  const norm = Object.keys(baseParams)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => {
      const v = baseParams[k];
      const encV = encodeURIComponent(String(v)).replace(/\+/g, "%20");
      return `${k.toLowerCase()}=${encV.toLowerCase()}`;
    })
    .join("&");

  const signature = hmac(cfg.algo, cfg.secret, norm);
  const encodedSig = encodeURIComponent(signature);

  const query = Object.entries(baseParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

  const sep = cfg.endpoint.includes("?") ? "&" : "?";
  return `${cfg.endpoint}${sep}${query}&signature=${encodedSig}`;
}

export async function callApi(command, params = {}) {
  const url = buildSignedUrl({ command, ...params });
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text} from: ${url} and params: ${JSON.stringify(params, null, 2)}`);
  }
  return res.json();
}

export function buildSignedUrlDebug(command, params = {}, { includeResponse = true, apiKeyField = "apiKey" } = {}) {
  const cfg = getConfig();
  if (!cfg.endpoint || !cfg.apiKey || !cfg.secret) {
    throw new Error(
      "MOLD 연결정보가 없습니다. mold_setConfig 도구로 endpoint/apiKey/secret 을 설정하세요."
    );
  }

  const baseParams = { ...(includeResponse ? { response: "json" } : {}), ...params, command };
  baseParams[apiKeyField] = cfg.apiKey;

  const normPairs = Object.keys(baseParams)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => {
      const v = baseParams[k];
      const encV = encodeURIComponent(String(v)).replace(/\+/g, "%20");
      return `${k.toLowerCase()}=${encV.toLowerCase()}`;
    });
  const normalized = normPairs.join("&");

  const signatureBase64 = hmac(cfg.algo, cfg.secret, normalized);
  const signatureUrlEncoded = encodeURIComponent(signatureBase64);

  const query = Object.entries(baseParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const sep = cfg.endpoint.includes("?") ? "&" : "?";
  const finalUrl = `${cfg.endpoint}${sep}${query}&signature=${signatureUrlEncoded}`;

  return {
    endpoint: cfg.endpoint,
    apiKeyFieldUsed: apiKeyField,
    includeResponse,
    normalized,
    signatureBase64,
    signatureUrlEncoded,
    finalUrl,
    signedParams: baseParams,
  };
}
