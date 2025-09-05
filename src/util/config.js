import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ALGO = (process.env.MOLD_SIG_ALGO || "sha256").toLowerCase();

let CONFIG = {
  endpoint: (process.env.MOLD_ENDPOINT || "").trim(),
  apiKey: (process.env.MOLD_API_KEY || "").trim(),
  secret: (process.env.MOLD_SECRET_KEY || "").trim(),
  algo: DEFAULT_ALGO,
};

export const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "mcp-mold")
  : path.join(os.homedir(), ".config", "mcp-mold");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function sanitizeConfig(obj = {}) {
  const out = {};
  if (typeof obj.endpoint === "string") out.endpoint = obj.endpoint.trim();
  if (typeof obj.apiKey === "string") out.apiKey = obj.apiKey.trim();
  if (typeof obj.secret === "string") out.secret = obj.secret.trim();
  if (typeof obj.algo === "string") out.algo = obj.algo.toLowerCase().trim();
  return out;
}

export function loadConfigFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const disk = JSON.parse(raw);
    CONFIG = { ...CONFIG, ...sanitizeConfig(disk) };
  } catch (_) {
    // ignore if missing or invalid
  }
}

export function saveConfigToDisk() {
  ensureDir(CONFIG_DIR);
  const data = {
    endpoint: CONFIG.endpoint,
    apiKey: CONFIG.apiKey,
    secret: CONFIG.secret,
    algo: CONFIG.algo,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function setConfig({ endpoint, apiKey, secret, algo } = {}, { persist = true } = {}) {
  const next = sanitizeConfig({ endpoint, apiKey, secret, algo });
  CONFIG = { ...CONFIG, ...next };
  if (persist) saveConfigToDisk();
  return getConfigRedacted();
}

export function getConfig() {
  return CONFIG;
}

export function getConfigRedacted() {
  const redact = (s = "") => {
    if (!s) return "";
    if (s.length <= 8) return "*".repeat(s.length);
    return s.slice(0, 4) + "***" + s.slice(-4);
  };
  return {
    endpoint: CONFIG.endpoint || "",
    apiKey: redact(CONFIG.apiKey),
    hasSecret: !!CONFIG.secret,
    algo: CONFIG.algo,
    configFile: CONFIG_FILE,
  };
}

// Load once on import
loadConfigFromDisk();
