import { z } from "zod";
import { callApi } from "./mold.js";
import { flattenParamsForMold, normalizeParamValue, sanitizeToolName } from "../util/params.js";

export function mapTypeToZod(type) {
  const t = String(type || "").toLowerCase();
  switch (t) {
    case "boolean":
      return z.union([z.boolean(), z.string()]);
    case "short":
    case "integer":
    case "int":
    case "long":
      return z.union([z.number(), z.string()]);
    case "uuid":
    case "tz":
    case "date":
    case "string":
    case "":
      return z.string();
    case "list":
    case "uuidlist":
    case "map":
    default:
      return z.union([
        z.string(),
        z.array(z.union([z.string(), z.number(), z.boolean()])),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      ]);
  }
}

export async function fetchApisMeta({ name } = {}) {
  const data = await callApi("listApis", name ? { name } : {});
  const resp = data.listapisresponse || data.listApisResponse || data.listapis || data;
  const apis = resp.api || resp.apis || resp;
  if (!apis || !Array.isArray(apis)) {
    throw new Error("listApis 응답을 파싱할 수 없습니다. (api 배열 없음)");
  }
  return apis.map((a) => ({
    name: a.name,
    description: a.description,
    isasync: !!a.isasync,
    since: a.since,
    related: a.related,
    params: Array.isArray(a.params)
      ? a.params.map((p) => ({
          name: p.name,
          type: p.type,
          required: !!p.required,
          description: p.description,
          length: p.length,
        }))
      : [],
  }));
}

export function buildInputSchemaFromParams(paramsMeta, { isasync }) {
  const schema = {};
  for (const p of paramsMeta) {
    const key = p.name;
    const ztype = mapTypeToZod(p.type);
    schema[key] = ztype;
  }
  if (isasync) {
    schema["_wait"] = z.union([z.boolean(), z.string()]).optional();
    schema["_timeoutMs"] = z.union([z.number(), z.string()]).optional();
    schema["_intervalMs"] = z.union([z.number(), z.string()]).optional();
  }
  return schema;
}

export function registerToolForApi(server, apiMeta, { namespace = "mold_" } = {}) {
  const rawName = `${namespace}${apiMeta.name}`;
  const toolName = sanitizeToolName(rawName);
  if (server.hasTool && server.hasTool(toolName)) return false;

  const inputSchema = buildInputSchemaFromParams(apiMeta.params, { isasync: apiMeta.isasync });
  const title = `${apiMeta.name}${apiMeta.isasync ? " (async)" : ""}`;
  const description = (apiMeta.description || "").trim() || `Invoke ${apiMeta.name}`;

  server.registerTool(
    toolName,
    { title, description, inputSchema },
    async (args = {}) => {
      const { _wait, _timeoutMs, _intervalMs, ...apiArgs } = args || {};
      const params = {};
      Object.keys(apiArgs).forEach((k) => {
        const v = apiArgs[k];
        if (v !== undefined) params[k] = normalizeParamValue(v);
      });
      const flat = flattenParamsForMold(apiArgs);
      const data = await callApi(apiMeta.name, flat);

      if (apiMeta.isasync && (_wait === true || _wait === "true")) {
        const resp = data[`${apiMeta.name.toLowerCase()}response`] || data;
        const jobid = resp.jobid || resp.jobId || data.jobid || data.jobId;
        if (!jobid) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };

        const timeoutMs = Number(_timeoutMs || 60000);
        const intervalMs = Number(_intervalMs || 2000);
        const start = Date.now();
        while (true) {
          const jr = await callApi("queryAsyncJobResult", { jobid });
          const jresp = jr.queryasyncjobresultresponse || jr.queryAsyncJobResultResponse || jr;
          const status = jresp.jobstatus;
          if (status === 1 || status === 2) {
            return { content: [{ type: "text", text: JSON.stringify(jr, null, 2) }] };
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(`timeout waiting job ${jobid} after ${timeoutMs}ms`);
          }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
  return true;
}

export async function autoRegisterApis(server, { include, exclude, limit, namespace } = {}) {
  const all = await fetchApisMeta();
  const inc = include ? new RegExp(include, "i") : null;
  const exc = exclude ? new RegExp(exclude, "i") : null;

  const filtered = all.filter((a) => {
    if (inc && !inc.test(a.name)) return false;
    if (exc && exc.test(a.name)) return false;
    return true;
  });

  const slice = typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  let count = 0;
  for (const meta of slice) {
    if (registerToolForApi(server, meta, { namespace })) count++;
  }
  return { total: slice.length, registered: count, namespace: namespace || "mold_" };
}
