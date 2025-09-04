
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* for Streamable HTTP (Known as sse) */
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"


function sanitizeToolName(name) {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return safe.length > 64 ? safe.slice(0, 64) : safe;
}
// ---- CloudStack 파라미터 플래튼(브래킷 표기) ----
// 규칙:
// - 배열[원시] => CSV (예: ["a","b"] -> "a,b")
// - 배열[객체] => key[i].sub=subv (예: datadisks[0].size=...)
// - 객체(톱레벨 값이 객체) => key[0].sub=subv (예: details[0].cpuNumber=...)
// - 이미 key에 '.' 또는 '[' 가 있으면(프리-플래튼) 그대로 사용
function flattenParamsForCloudStack(params = {}) {
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
        // 원시 배열은 CSV
        put(base, val.map(x => String(x)).join(","));
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

    // 사용자가 이미 details[0].cpuNumber 같은 브래킷/닷 표기로 넣었으면 그대로 사용
    if (/[.\[]/.test(key)) { put(key, val); continue; }

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
        // 원시 배열은 CSV
        put(key, val.map(x => String(x)).join(","));
      }
      continue;
    }

    if (typeof val === "object") {
      // 톱레벨 객체는 [0]로 매핑 (details, iptonetworklist 등)
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

    // 원시값
    put(key, val);
  }

  return out;
}
// -------- 설정(사용자 입력/프로필 지원) --------
const DEFAULT_ALGO = (process.env.CLOUDSTACK_SIG_ALGO || "sha256").toLowerCase(); // "sha1" 또는 "sha256"

let CONFIG = {
    endpoint: (process.env.CLOUDSTACK_ENDPOINT || "").trim(),
    apiKey: (process.env.CLOUDSTACK_API_KEY || "").trim(),
    secret: (process.env.CLOUDSTACK_SECRET_KEY || "").trim(),
    algo: DEFAULT_ALGO
};

// XDG 기준 경로(~/.config) 사용
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "mcp-cloudstack")
    : path.join(os.homedir(), ".config", "mcp-cloudstack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function ensureDir(dir) {
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

function loadConfigFromDisk() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf8");
        const disk = JSON.parse(raw);
        // 디스크 값을 우선 병합(이후 사용자가 setConfig로 재설정 가능)
        CONFIG = { ...CONFIG, ...sanitizeConfig(disk) };
    } catch (_) { /* 파일이 없거나 파싱 실패 시 무시 */ }
}

function saveConfigToDisk() {
    ensureDir(CONFIG_DIR);
    const data = {
        endpoint: CONFIG.endpoint,
        apiKey: CONFIG.apiKey,
        secret: CONFIG.secret,
        algo: CONFIG.algo
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function setConfig({ endpoint, apiKey, secret, algo } = {}, { persist = true } = {}) {
    const next = sanitizeConfig({ endpoint, apiKey, secret, algo });
    CONFIG = { ...CONFIG, ...next };
    if (persist) saveConfigToDisk();
    return getConfigRedacted();
}

function getConfigRedacted() {
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
        configFile: CONFIG_FILE
    };
}

// 시작 시 디스크 구성 로드
loadConfigFromDisk();

function assertEnv() {
    if (!CONFIG.endpoint || !CONFIG.apiKey || !CONFIG.secret) {
        throw new Error("CloudStack 연결정보가 없습니다. mold_setConfig 도구로 endpoint/apiKey/secret 을 설정하세요.");
    }
}

// -------- CloudStack 서명/호출 유틸 --------
// 서명 절차: 값 URL인코딩 → 전체 소문자화 → 키 정렬 → HMAC-(SHA1|SHA256) → Base64 → URL인코딩
function hmac(algo, secret, data) {
    return crypto.createHmac(algo, secret).update(data).digest("base64");
}


// -------- CloudStack 서명/호출 유틸 --------
// 서명 절차: 값 URL인코딩 → 전체 소문자화 → 키 정렬 → HMAC-SHA1 → Base64 → URL인코딩
function buildSignedUrl(params) {
    assertEnv();

    console.error("[mcp-cloudstack] buildSignedUrl:", params);
    // 최종 요청에 들어갈 쿼리(원본 값): command/params + apiKey + response=json
    const baseParams = { response: "json", ...params, apiKey: CONFIG.apiKey };
    console.error("[mcp-cloudstack] baseParams:", baseParams);

    // 1) 값 URL 인코딩 → 2) 전체 소문자화 → 3) 필드명으로 정렬
    const norm = Object.keys(baseParams)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .map(k => {
            const v = baseParams[k];
            // 값만 URL 인코딩, 그리고 '+' 대신 '%20' 규칙 확보
            const encV = encodeURIComponent(String(v)).replace(/\+/g, '%20');
            return `${k.toLowerCase()}=${encV.toLowerCase()}`;
        })
        .join("&");

    const signature = hmac(CONFIG.algo, CONFIG.secret, norm);
    const encodedSig = encodeURIComponent(signature);

    const query = Object.entries(baseParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");

    const sep = CONFIG.endpoint.includes("?") ? "&" : "?";
    return `${CONFIG.endpoint}${sep}${query}&signature=${encodedSig}`;
}

async function callApi(command, params = {}) {
    console.error("[mcp-cloudstack] callApi params:", params);
    const url = buildSignedUrl({ command, ...params });
    const res = await fetch(url);
    // CloudStack는 401(서명/권한 오류) 등을 반환할 수 있음
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text} from: ${url} and params: ${JSON.stringify(params, null, 2)}`);
    }
    return res.json();
}

async function callApi_Debug(command, params = {}) {
    const url = buildSignedUrl({ command, ...params });
    console.error("[mcp-cloudstack] params:", params);
    const res = null;
    // CloudStack는 401(서명/권한 오류) 등을 반환할 수 있음
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text} from: ${url} and params: ${JSON.stringify(params, null, 2)}`);
    }
    return res.json();
}
// -------- MCP 서버 --------
const server = new McpServer(
    {
        name: "mcp-cloudstack-421", version: "0.1.0"
    },
    {
        capabilities: {
            resources: {},
            tools: {},
            prompts: {},
        },
        debug: true, // 디버그 모드 활성화
        logLevel: "verbose" // 상세 로깅 설정
    });

// 1) 범용 호출 도구
server.registerTool(
    "mold_call_debug",
    {
        title: "CloudStack API 호출(범용)",
        description: "임의의 CloudStack API 명령을 호출합니다. (command + params)",
        inputSchema: {
            command: z.string(),
            params: z.record(z.string(), z.union([
                z.string(), z.number(), z.boolean(), 
                z.record(z.string(), z.union([
                    z.string(), z.number(), z.boolean(),
                    z.record(z.string(), z.union([
                        z.string(), z.number(), z.boolean(),
                    ])) 
                ])) 
            ]))
            .optional()
        }
    },
    async ({ command, params }) => {
        const flat = flattenParamsForCloudStack(params ?? {});
        const data = await callApi(command, flat);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);
// 1) 범용 호출 도구
server.registerTool(
    "mold_call",
    {
        title: "CloudStack API 호출(범용)",
        description: "임의의 CloudStack API 명령을 호출합니다. (command + params)",
        inputSchema: {
            command: z.string(),
            params: z.record(z.string(), z.union([
                z.string(), z.number(), z.boolean(), 
                z.record(z.string(), z.union([
                    z.string(), z.number(), z.boolean(),
                    z.record(z.string(), z.union([
                        z.string(), z.number(), z.boolean(),
                    ])) 
                ])) 
            ]))
            .optional()
        }
    },
    async ({ command, params }) => {
        const flat = flattenParamsForCloudStack(params ?? {});
        console.error("[mcp-cloudstack] flat:", flat);
        const data = await callApi(command, flat);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// 2) listVirtualMachines 편의 도구 (4.21)
server.registerTool(
    "mold_listVirtualMachines",
    {
        title: "VM 목록 조회",
        description: "listVirtualMachines(4.21) 호출. 주요 필터만 노출(추가 필드는 mold_call 사용).",
        inputSchema: {
            keyword: z.string().optional(),
            id: z.string().optional(),
            name: z.string().optional(),
            state: z.enum(["Running", "Stopped", "Present", "Destroyed", "Expunged"]).optional(),
            zoneid: z.string().optional(),
            projectid: z.string().optional(),
            domainid: z.string().optional(),
            account: z.string().optional(),
            listall: z.boolean().optional(),
            details: z.string().optional(), // "all,stats,..." 등 CSV
            page: z.number().int().optional(),
            pagesize: z.number().int().optional()
        }
    },
    async (args) => {
        const data = await callApi("listVirtualMachines", args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// 3) startVirtualMachine (비동기)
server.registerTool(
    "mold_startVirtualMachine",
    {
        title: "VM 시작",
        description: "startVirtualMachine(4.21). 반환에 jobid가 포함될 수 있음(비동기).",
        inputSchema: {
            id: z.string(),
            hostid: z.string().optional(),
            clusterid: z.string().optional(),
            podid: z.string().optional(),
            considerlasthost: z.boolean().optional(),
            bootintosetup: z.boolean().optional()
        }
    },
    async (args) => {
        const data = await callApi("startVirtualMachine", args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// 4) stopVirtualMachine (비동기)
server.registerTool(
    "mold_stopVirtualMachine",
    {
        title: "VM 정지",
        description: "stopVirtualMachine(4.21). forced 옵션 지원. 반환에 jobid 포함 가능.",
        inputSchema: {
            id: z.string(),
            forced: z.boolean().optional()
        }
    },
    async (args) => {
        const data = await callApi("stopVirtualMachine", args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// 5) 비동기 잡 대기 편의 도구 (queryAsyncJobResult 폴링)
server.registerTool(
    "mold_waitForJob",
    {
        title: "비동기 잡 완료 대기",
        description: "queryAsyncJobResult를 주기적으로 호출하여 완료(1)/실패(2)까지 대기.",
        inputSchema: {
            jobid: z.string(),
            timeoutMs: z.number().int().optional(),   // 기본 60000
            intervalMs: z.number().int().optional()   // 기본 2000
        }
    },
    async ({ jobid, timeoutMs = 60000, intervalMs = 2000 }) => {
        const start = Date.now();
        while (true) {
            const data = await callApi("queryAsyncJobResult", { jobid });
            const resp = data.queryasyncjobresultresponse ?? data.queryasyncjobresult ?? data;
            const status = resp.jobstatus;
            if (status === 1 || status === 2) {
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(`timeout after ${timeoutMs}ms`);
            }
            await new Promise(r => setTimeout(r, intervalMs));
        }
    }
);
// ===== [NEW] 디버그용 서명 생성기 + MCP 툴 =====
function buildSignedUrlDebug(command, params = {}, { includeResponse = true, apiKeyField = "apiKey" } = {}) {
    if (!CONFIG.endpoint || !CONFIG.apiKey || !CONFIG.secret) {
        throw new Error("CloudStack 연결정보가 없습니다. mold_setConfig 도구로 endpoint/apiKey/secret 을 설정하세요.");
    }

    // 1) 실제 쿼리에 넣을 파라미터(서명 제외)
    const baseParams = { ...(includeResponse ? { response: "json" } : {}), ...params, command };
    baseParams[apiKeyField] = CONFIG.apiKey; // apiKey or apikey (필드명은 case-insensitive)

    // 2) 정규화 문자열(norm) 생성: 값 URL 인코딩 → 전체 소문자화 → 필드명(소문자) 정렬
    const normPairs = Object.keys(baseParams)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .map(k => {
            const v = baseParams[k];
            const encV = encodeURIComponent(String(v)).replace(/\+/g, "%20");
            return `${k.toLowerCase()}=${encV.toLowerCase()}`;
        });
    const normalized = normPairs.join("&");

    // 3) 서명: HMAC-SHA1 → Base64 → URL 인코딩
    const signatureBase64 = hmac(CONFIG.algo, CONFIG.secret, normalized);
    const signatureUrlEncoded = encodeURIComponent(signatureBase64);

    // 4) 실제 요청용 쿼리스트링(원본값 URL 인코딩)
    const query = Object.entries(baseParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
    const sep = CONFIG.endpoint.includes("?") ? "&" : "?";
    const finalUrl = `${CONFIG.endpoint}${sep}${query}&signature=${signatureUrlEncoded}`;

    return {
        endpoint: CONFIG.endpoint,
        apiKeyFieldUsed: apiKeyField,
        includeResponse,
        normalized,               // 서명에 사용된 정규화 문자열(문서 단계 1~2 적용)
        signatureBase64,          // Base64 서명(문서 단계 3)
        signatureUrlEncoded,      // URL에 들어갈 서명
        finalUrl,                 // 최종 요청 URL (복사해 호출 가능)
        signedParams: baseParams  // 실제 서명/전송에 사용된 파라미터(서명 제외)
    };
}

// 6) 구성 보기/설정 도구
server.registerTool(
    "mold_getConfig",
    {
        title: "CloudStack 연결정보 조회",
        description: "현재 사용 중인 endpoint/apiKey(마스킹)/알고리즘/구성파일 경로를 반환합니다.",
        inputSchema: {}
    },
    async () => {
        return { content: [{ type: "text", text: JSON.stringify(getConfigRedacted(), null, 2) }] };
    }
);

server.registerTool(
    "mold_setConfig",
    {
        title: "CloudStack 연결정보 설정",
        description: "endpoint, apiKey, secret 및 서명 알고리즘(sha1|sha256)을 설정합니다. 기본은 sha256. persist=true면 디스크에 저장.",
        inputSchema: {
            endpoint: z.string().optional(),
            apiKey: z.string().optional(),
            secret: z.string().optional(),
            algo: z.enum(["sha1", "sha256"]).optional(),
            persist: z.boolean().optional() // 기본 true
        }
    },
    async ({ endpoint, apiKey, secret, algo, persist = true }) => {
        const info = setConfig({ endpoint, apiKey, secret, algo }, { persist });
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
);
// ===== [NEW] API Discovery 기반 동적 도구 생성 =====
// 참고: listApis 응답 구조와 파라미터 메타는 4.21 API 문서의 listApis 페이지 명세를 따릅니다.
//  - name/isasync/params(name,type,required,...) 등을 사용해 입력 스키마를 구성합니다.
//  - 비동기 API(isasync=true)는 _wait/_timeoutMs 옵션을 추가로 지원합니다.

function mapTypeToZod(type) {
    const t = String(type || "").toLowerCase();
    switch (t) {
        case "boolean":
            // CloudStack는 쿼리스트링 문자열이므로 true/false 문자열도 허용
            return z.union([z.boolean(), z.string()]);
        case "short":
        case "integer":
        case "int":
        case "long":
            return z.union([z.number(), z.string()]); // 안전하게 문자열 숫자도 허용
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
            // list/map 등은 CSV 또는 bracket-notation을 쓰므로 문자열/배열/레코드 모두 수용
            return z.union([
                z.string(),
                z.array(z.union([z.string(), z.number(), z.boolean()])),
                z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            ]);
    }
}

// 배열/레코드 입력을 CloudStack 쿼리 파라미터로 안전 변환
function normalizeParamValue(v) {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) {
        // 배열은 CSV로 변환
        return v.map(x => String(x)).join(",");
    }
    if (typeof v === "object") {
        // 단순 map은 key=value 형태를 ';'로 연결(일부 API는 세부 표기법을 사용하므로 원본 문자열을 선호)
        // 사용자가 문자열로 직접 넘기는 것을 권장. 여기서는 best-effort로 직렬화.
        const parts = [];
        for (const [k, val] of Object.entries(v)) {
            parts.push(`${k}=${String(val)}`);
        }
        return parts.join(";");
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
}

// listApis 호출 및 메타 추출
async function fetchApisMeta({ name } = {}) {
    const data = await callApi("listApis", name ? { name } : {});
    const resp = data.listapisresponse || data.listApisResponse || data.listapis || data;
    const apis = resp.api || resp.apis || resp;
    if (!apis || !Array.isArray(apis)) {
        throw new Error("listApis 응답을 파싱할 수 없습니다. (api 배열 없음)");
    }
    // 필요한 필드만 정규화
    return apis.map(a => ({
        name: a.name,
        description: a.description,
        isasync: !!a.isasync,
        since: a.since,
        related: a.related,
        params: Array.isArray(a.params) ? a.params.map(p => ({
            name: p.name,
            type: p.type,
            required: !!p.required,
            description: p.description,
            length: p.length
        })) : []
    }));
}

// 파라미터 메타로 MCP inputSchema 구성
function buildInputSchemaFromParams(paramsMeta, { isasync }) {
    const schema = {};
    for (const p of paramsMeta) {
        // CloudStack는 대부분 소문자/카멜 혼재 → 문서 명시 그대로 사용
        const key = p.name;
        const ztype = mapTypeToZod(p.type);
        // required라도 MCP에서 강제 검증까지 하진 않음(클라 UX 목적). 설명에만 남김.
        schema[key] = ztype;
    }
    if (isasync) {
        // 비동기 편의 옵션
        schema["_wait"] = z.union([z.boolean(), z.string()]).optional();
        schema["_timeoutMs"] = z.union([z.number(), z.string()]).optional();
        schema["_intervalMs"] = z.union([z.number(), z.string()]).optional();
    }
    return schema;
}

// 단일 API 메타로 MCP 도구 등록
function registerToolForApi(apiMeta, { namespace = "mold_" } = {}) {
    const rawName = `${namespace}${apiMeta.name}`;   // 예: "mold_deployVirtualMachine"
    const toolName = sanitizeToolName(rawName);
    // 중복 등록 방지: 이미 등록된 이름이면 skip
    if (server.hasTool && server.hasTool(toolName)) {
        return false;
    }
    const inputSchema = buildInputSchemaFromParams(apiMeta.params, { isasync: apiMeta.isasync });
    const title = `${apiMeta.name}${apiMeta.isasync ? " (async)" : ""}`;
    const description = (apiMeta.description || "").trim() || `Invoke ${apiMeta.name}`;

    server.registerTool(
        toolName,
        { title, description, inputSchema },
        async (args = {}) => {
            // 편의 옵션 분리
            const { _wait, _timeoutMs, _intervalMs, ...apiArgs } = args || {};
            // 값 정규화
            const params = {};
            Object.keys(apiArgs).forEach(k => {
                const v = apiArgs[k];
                if (v !== undefined) params[k] = normalizeParamValue(v);
            });
            const flat = flattenParamsForCloudStack(apiArgs);
            const data = await callApi(apiMeta.name, flat);
            // 비동기면 옵션에 따라 폴링
            if (apiMeta.isasync && (_wait === true || _wait === "true")) {
                const resp = data[`${apiMeta.name.toLowerCase()}response`] || data;
                const jobid =
                    resp.jobid ||
                    resp.jobId ||
                    (data.jobid || data.jobId);
                if (!jobid) {
                    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
                }
                const timeoutMs = Number(_timeoutMs || 60000);
                const intervalMs = Number(_intervalMs || 2000);
                // 내부 폴링
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
                    await new Promise(r => setTimeout(r, intervalMs));
                }
            }
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );
    return true;
}

// 다수 API를 일괄 등록
async function autoRegisterApis({ include, exclude, limit, namespace } = {}) {
    const all = await fetchApisMeta();
    const inc = include ? new RegExp(include, "i") : null;
    const exc = exclude ? new RegExp(exclude, "i") : null;

    const filtered = all.filter(a => {
        if (inc && !inc.test(a.name)) return false;
        if (exc && exc.test(a.name)) return false;
        return true;
    });

    const slice = typeof limit === "number" ? filtered.slice(0, limit) : filtered;
    let count = 0;
    for (const meta of slice) {
        if (registerToolForApi(meta, { namespace })) count++;
    }
    return { total: slice.length, registered: count, namespace: namespace || "mold_" };
}

// 7) listApis 메타 조회 도구
server.registerTool(
    "mold_listApisMeta",
    {
        title: "CloudStack listApis 메타 조회",
        description: "listApis로부터 API 메타데이터(name, isasync, params)를 조회합니다.",
        inputSchema: {
            name: z.string().optional()
        }
    },
    async ({ name }) => {
        const metas = await fetchApisMeta({ name });
        return { content: [{ type: "text", text: JSON.stringify(metas, null, 2) }] };
    }
);

// 8) 모든 API 자동 등록 도구
server.registerTool(
    "mold_autoRegisterApis",
    {
        title: "CloudStack 모든 API 동적 등록",
        description: "listApis를 기반으로 MCP 도구를 일괄 등록합니다. include/exclude는 정규식.",
        inputSchema: {
            include: z.string().optional(),  // 예: "^list|^get"
            exclude: z.string().optional(),  // 예: "Deprecated|^changeServiceForVirtualMachine$"
            limit: z.number().int().optional(),
            namespace: z.string().optional() // 기본 "mold_"
        }
    },
    async ({ include, exclude, limit, namespace }) => {
        const result = await autoRegisterApis({ include, exclude, limit, namespace });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
);
server.registerTool(
    "mold_signDebug",
    {
        title: "CloudStack 서명/URL 디버그",
        description: "정규화 문자열, 서명(Base64), URL 인코딩 서명, 최종 요청 URL을 생성해 점검합니다.",
        inputSchema: {
            command: z.string(),
            params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
            includeResponse: z.boolean().optional(),              // 기본 true → response=json 포함
            apiKeyField: z.enum(["apiKey", "apikey"]).optional()  // 표기 취향(실제로는 대소문자 비민감)
        }
    },
    async ({ command, params, includeResponse = true, apiKeyField = "apiKey" }) => {
        const dbg = buildSignedUrlDebug(command, params ?? {}, { includeResponse, apiKeyField });
        return { content: [{ type: "text", text: JSON.stringify(dbg, null, 2) }] };
    }
);

// (선택) 시작 시 자동 등록: 환경변수 CLOUDSTACK_AUTOREGISTER=all 설정 시 전체 등록
if (process.env.CLOUDSTACK_AUTOREGISTER === "all") {
    try {
        await autoRegisterApis();
        // stderr 로깅만 (stdio 프로토콜 보호)
        console.error("[mcp-cloudstack] auto-registered all APIs from listApis");
    } catch (e) {
        console.error("[mcp-cloudstack] auto-register failed:", e?.message || e);
    }
}



// 시작 (stdio)
const transports = {
    stdio: new StdioServerTransport(),
};
await server.connect(transports.stdio);