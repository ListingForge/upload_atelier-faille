// Remote-MCP-Endpoint (Streamable HTTP, stateless) hinter Bearer-Auth.
// Jede POST /mcp bekommt eine frische Server+Transport-Instanz (stateless-Modus:
// sessionIdGenerator undefined). GET/DELETE werden nicht unterstützt.

import express, { type Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcpTools";
import { verifyBearer } from "./mcpOAuth";

export function createMcpHttpRouter(): Router {
  const router = express.Router();

  router.post("/", verifyBearer, async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: e?.message || "MCP-Fehler" },
          id: null,
        });
      }
    }
  });

  // Stateless: keine SSE-Streams / Sessions.
  router.get("/", verifyBearer, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed (stateless)" },
      id: null,
    });
  });

  return router;
}
