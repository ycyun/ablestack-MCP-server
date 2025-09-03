import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "crypto";

// -------- 설정 --------
const ENDPOINT = (process.env.CLOUDSTACK_ENDPOINT || "").trim();
const API_KEY  = (process.env.CLOUDSTACK_API_KEY || "").trim();
const SECRET   = (process.env.CLOUDSTACK_SECRET_KEY || "").trim();
const SIG_ALGO = (process.env.CLOUDSTACK_SIG_ALGO || "sha256").toLowerCase(); // "sha1" 또는 "sha256"

function assertEnv() {
  if (!ENDPOINT || !API_KEY || !SECRET) {
    throw new Error("환경변수 CLOUDSTACK_ENDPOINT, CLOUDSTACK_API_KEY, CLOUDSTACK_SECRET_KEY 를 설정하세요.");
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

  // 최종 요청에 들어갈 쿼리(원본 값): command/params + apiKey + response=json
  const baseParams = { response: "json", ...params, apiKey: API_KEY };

//   // 시그니처용 정규화 문자열
//   const entries = Object.entries(baseParams);
//   const norm = entries
//     .map(([k, v]) => [k.toLowerCase(), encodeURIComponent(String(v)).toLowerCase()])
//     .sort((a, b) => a[0].localeCompare(b[0]))
//     .map(([k, v]) => `${k}=${v}`)
//     .join("&");
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

  //const signature = crypto.createHmac("sha256", SECRET).update(norm).digest("base64");
  const signature = hmac(SIG_ALGO, SECRET, norm);
  const encodedSig = encodeURIComponent(signature);

  // 실제 요청용 쿼리문자열(값은 원본을 URL인코딩, 소문자화하지 않음)
//   const query = entries
//     .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
//     .join("&");
    
    const query = Object.entries(baseParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

  const sep = ENDPOINT.includes("?") ? "&" : "?";
  return `${ENDPOINT}${sep}${query}&signature=${encodedSig}`;
}

async function callApi(command, params = {}) {
  const url = buildSignedUrl({ command, ...params });
  const res = await fetch(url);
  // CloudStack는 401(서명/권한 오류) 등을 반환할 수 있음
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text} from: ${url}`);
  }
  return res.json();
}

// -------- MCP 서버 --------
const server = new McpServer({ name: "mcp-cloudstack-421", version: "0.1.0" });

// 1) 범용 호출 도구
server.registerTool(
  "cloudstack.call",
  {
    title: "CloudStack API 호출(범용)",
    description: "임의의 CloudStack API 명령을 호출합니다. (command + params)",
    inputSchema: {
      command: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    }
  },
  async ({ command, params }) => {
    const data = await callApi(command, params ?? {});
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// 2) listVirtualMachines 편의 도구 (4.21)
server.registerTool(
  "cloudstack.listVirtualMachines",
  {
    title: "VM 목록 조회",
    description: "listVirtualMachines(4.21) 호출. 주요 필터만 노출(추가 필드는 cloudstack.call 사용).",
    inputSchema: {
      keyword: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      state: z.enum(["Running","Stopped","Present","Destroyed","Expunged"]).optional(),
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
  "cloudstack.startVirtualMachine",
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
  "cloudstack.stopVirtualMachine",
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
  "cloudstack.waitForJob",
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
  if (!ENDPOINT || !API_KEY || !SECRET) {
    throw new Error("환경변수 CLOUDSTACK_ENDPOINT, CLOUDSTACK_API_KEY, CLOUDSTACK_SECRET_KEY 를 설정하세요.");
  }

  // 1) 실제 쿼리에 넣을 파라미터(서명 제외)
  const baseParams = { ...(includeResponse ? { response: "json" } : {}), ...params, command };
  baseParams[apiKeyField] = API_KEY; // apiKey or apikey (필드명은 case-insensitive)

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
  //const signatureBase64 = crypto.createHmac("sha256", SECRET).update(normalized).digest("base64");
  const signatureBase64 = hmac(SIG_ALGO, SECRET, normalized);
  const signatureUrlEncoded = encodeURIComponent(signatureBase64);

  // 4) 실제 요청용 쿼리스트링(원본값 URL 인코딩)
  const query = Object.entries(baseParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const sep = ENDPOINT.includes("?") ? "&" : "?";
  const finalUrl = `${ENDPOINT}${sep}${query}&signature=${signatureUrlEncoded}`;

  return {
    endpoint: ENDPOINT,
    apiKeyFieldUsed: apiKeyField,
    includeResponse,
    normalized,               // 서명에 사용된 정규화 문자열(문서 단계 1~2 적용)
    signatureBase64,          // Base64 서명(문서 단계 3)
    signatureUrlEncoded,      // URL에 들어갈 서명
    finalUrl,                 // 최종 요청 URL (복사해 호출 가능)
    signedParams: baseParams  // 실제 서명/전송에 사용된 파라미터(서명 제외)
  };
}

// MCP 도구 등록
server.registerTool(
  "cloudstack.signDebug",
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
// 시작 (stdio)
const transport = new StdioServerTransport();
await server.connect(transport);