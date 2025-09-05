import { z } from "zod";
import { callApi, buildSignedUrlDebug } from "../api/mold.js";
import { getConfigRedacted, setConfig } from "../util/config.js";
import { flattenParamsForMold } from "../util/params.js";
import { autoRegisterApis, fetchApisMeta } from "../api/discovery.js";

export function registerCoreTools(server) {
  // Generic call (debug)
  server.registerTool(
    "mold_call_debug",
    {
      title: "MOLD API 호출(범용)",
      description: "임의의 MOLD API 명령을 호출합니다. (command + params)",
      inputSchema: {
        command: z.string(),
        params: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.record(
                z.string(),
                z.union([
                  z.string(),
                  z.number(),
                  z.boolean(),
                  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
                ])
              ),
            ])
          )
          .optional(),
      },
    },
    async ({ command, params }) => {
      const flat = flattenParamsForMold(params ?? {});
      const data = await callApi(command, flat);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Generic call
  server.registerTool(
    "mold_call",
    {
      title: "MOLD API 호출(범용)",
      description: "임의의 MOLD API 명령을 호출합니다. (command + params)",
      inputSchema: {
        command: z.string(),
        params: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.record(
                z.string(),
                z.union([
                  z.string(),
                  z.number(),
                  z.boolean(),
                  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
                ])
              ),
            ])
          )
          .optional(),
      },
    },
    async ({ command, params }) => {
      const flat = flattenParamsForMold(params ?? {});
      const data = await callApi(command, flat);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Convenience: listVirtualMachines
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
        details: z.string().optional(),
        page: z.number().int().optional(),
        pagesize: z.number().int().optional(),
      },
    },
    async (args) => {
      const data = await callApi("listVirtualMachines", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // startVirtualMachine
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
        bootintosetup: z.boolean().optional(),
      },
    },
    async (args) => {
      const data = await callApi("startVirtualMachine", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // stopVirtualMachine
  server.registerTool(
    "mold_stopVirtualMachine",
    {
      title: "VM 정지",
      description: "stopVirtualMachine(4.21). forced 옵션 지원. 반환에 jobid 포함 가능.",
      inputSchema: {
        id: z.string(),
        forced: z.boolean().optional(),
      },
    },
    async (args) => {
      const data = await callApi("stopVirtualMachine", args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // wait for async job
  server.registerTool(
    "mold_waitForJob",
    {
      title: "비동기 잡 완료 대기",
      description: "queryAsyncJobResult를 주기적으로 호출하여 완료(1)/실패(2)까지 대기.",
      inputSchema: {
        jobid: z.string(),
        timeoutMs: z.number().int().optional(),
        intervalMs: z.number().int().optional(),
      },
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
        if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  );

  // config get/set
  server.registerTool(
    "mold_getConfig",
    {
      title: "MOLD 연결정보 조회",
      description: "현재 사용 중인 endpoint/apiKey(마스킹)/알고리즘/구성파일 경로를 반환합니다.",
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(getConfigRedacted(), null, 2) }] };
    }
  );

  server.registerTool(
    "mold_setConfig",
    {
      title: "MOLD 연결정보 설정",
      description:
        "endpoint, apiKey, secret 및 서명 알고리즘(sha1|sha256)을 설정합니다. 기본은 sha256. persist=true면 디스크에 저장.",
      inputSchema: {
        endpoint: z.string().optional(),
        apiKey: z.string().optional(),
        secret: z.string().optional(),
        algo: z.enum(["sha1", "sha256"]).optional(),
        persist: z.boolean().optional(),
      },
    },
    async ({ endpoint, apiKey, secret, algo, persist = true }) => {
      const info = setConfig({ endpoint, apiKey, secret, algo }, { persist });
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  // listApis meta
  server.registerTool(
    "mold_listApisMeta",
    {
      title: "MOLD listApis 메타 조회",
      description: "listApis로부터 API 메타데이터(name, isasync, params)를 조회합니다.",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => {
      const metas = await fetchApisMeta({ name });
      return { content: [{ type: "text", text: JSON.stringify(metas, null, 2) }] };
    }
  );

  // auto register
  server.registerTool(
    "mold_autoRegisterApis",
    {
      title: "MOLD 모든 API 동적 등록",
      description: "listApis를 기반으로 MCP 도구를 일괄 등록합니다. include/exclude는 정규식.",
      inputSchema: {
        include: z.string().optional(),
        exclude: z.string().optional(),
        limit: z.number().int().optional(),
        namespace: z.string().optional(),
      },
    },
    async ({ include, exclude, limit, namespace }) => {
      const result = await autoRegisterApis(server, { include, exclude, limit, namespace });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // signature debugger
  server.registerTool(
    "mold_signDebug",
    {
      title: "MOLD 서명/URL 디버그",
      description: "정규화 문자열, 서명(Base64), URL 인코딩 서명, 최종 요청 URL을 생성해 점검합니다.",
      inputSchema: {
        command: z.string(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        includeResponse: z.boolean().optional(),
        apiKeyField: z.enum(["apiKey", "apikey"]).optional(),
      },
    },
    async ({ command, params, includeResponse = true, apiKeyField = "apiKey" }) => {
      const dbg = buildSignedUrlDebug(command, params ?? {}, { includeResponse, apiKeyField });
      return { content: [{ type: "text", text: JSON.stringify(dbg, null, 2) }] };
    }
  );
}
