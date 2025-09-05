import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCoreTools } from "./src/app/tools.js";
import { autoRegisterApis } from "./src/api/discovery.js";
import { startStreamableHttp } from "./src/app/http.js";

const server = new McpServer(
  { name: "mcp-mold-server", version: "0.1.0" },
  {
    capabilities: { resources: {}, tools: {}, prompts: {} },
    debug: true,
    logLevel: "verbose",
  }
);

registerCoreTools(server);

if (process.env.MOLD_AUTOREGISTER === "all") {
  try {
    await autoRegisterApis(server);
    console.error("[mcp-mold] auto-registered all APIs from listApis");
  } catch (e) {
    console.error("[mcp-mold] auto-register failed:", e?.message || e);
  }
}

const transports = { stdio: new StdioServerTransport() };
await server.connect(transports.stdio);

// Optional: start HTTP transport when requested
if (process.env.MCP_HTTP_ENABLE === "1" || process.env.MOLD_HTTP_ENABLE === "1") {
  await startStreamableHttp();
}
