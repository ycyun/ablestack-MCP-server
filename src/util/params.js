export function sanitizeToolName(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length > 64 ? safe.slice(0, 64) : safe;
}

// MOLD parameter flattener (supports bracket & dot notation)
export function flattenParamsForMold(params = {}) {
  const out = {};

  const put = (k, v) => {
    if (v === undefined || v === null) return;
    out[k] = String(v);
  };

  const walkNested = (val, base) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      if (val.length && typeof val[0] === "object") {
        val.forEach((item, i) => walkNested(item, `${base}[${i}]`));
      } else {
        put(base, val.map((x) => String(x)).join(","));
      }
      return;
    }
    if (typeof val === "object") {
      for (const [sk, sv] of Object.entries(val)) {
        if (sv === undefined || sv === null) continue;
        if (typeof sv === "object" && !Array.isArray(sv)) {
          walkNested(sv, `${base}.${sk}`);
        } else {
          put(`${base}.${sk}`, sv);
        }
      }
      return;
    }
    put(base, val);
  };

  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null) continue;
    if (/[.\[]/.test(key)) {
      put(key, val);
      continue;
    }
    if (Array.isArray(val)) {
      if (val.length && typeof val[0] === "object") {
        val.forEach((item, i) => {
          for (const [sk, sv] of Object.entries(item || {})) {
            if (sv === undefined || sv === null) continue;
            if (typeof sv === "object" && !Array.isArray(sv)) {
              walkNested(sv, `${key}[${i}].${sk}`);
            } else {
              put(`${key}[${i}].${sk}`, sv);
            }
          }
        });
      } else {
        put(key, val.map((x) => String(x)).join(","));
      }
      continue;
    }
    if (typeof val === "object") {
      for (const [sk, sv] of Object.entries(val)) {
        if (sv === undefined || sv === null) continue;
        if (typeof sv === "object" && !Array.isArray(sv)) {
          walkNested(sv, `${key}[0].${sk}`);
        } else {
          put(`${key}[0].${sk}`, sv);
        }
      }
      continue;
    }
    put(key, val);
  }
  return out;
}

export function normalizeParamValue(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  if (typeof v === "object") {
    const parts = [];
    for (const [k, val] of Object.entries(v)) parts.push(`${k}=${String(val)}`);
    return parts.join(";");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
