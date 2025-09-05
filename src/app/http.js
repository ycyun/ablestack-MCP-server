import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerCoreTools } from "./tools.js";

function createServerInstance() {
  const server = new McpServer(
    { name: "mcp-mold-server", version: "0.1.0" },
    {
      capabilities: { resources: {}, tools: {}, prompts: {} },
      debug: true,
      logLevel: "verbose",
    }
  );
  registerCoreTools(server);
  return server;
}

export async function startStreamableHttp({ port } = {}) {
  const httpPort = Number(
    port ?? process.env.MCP_HTTP_PORT ?? process.env.MOLD_HTTP_PORT ?? 3000
  );

  const app = express();
  app.use(express.json());

  const transports = /** @type {Record<string, StreamableHTTPServerTransport>} */ ({});

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]; // header name is case-insensitive in Node
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
        // Consider enabling DNS rebinding protection for local deployments:
        // enableDnsRebindingProtection: true,
        // allowedHosts: ["127.0.0.1"],
      });

      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const server = createServerInstance();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  await new Promise((resolve, reject) => {
    const server = app.listen(httpPort, (err) => {
      if (err) reject(err);
      else resolve();
    });
    server.on("error", reject);
  });

  console.error(`[mcp-mold] Streamable HTTP listening on :${httpPort}`);
}
