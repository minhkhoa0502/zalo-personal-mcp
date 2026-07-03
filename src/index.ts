/**
 * zalo-personal-mcp — MCP server for a personal Zalo account.
 *
 * The server restores a saved session lazily (on first tool call). Run
 * `npm run login` once beforehand to create the session via QR code.
 * See docs/adr/0001-architecture-and-dependency-strategy.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { hasSession } from "./session.js";
import { configureEgress } from "./net.js";

configureEgress();

const server = new McpServer({
  name: "zalo-personal-mcp",
  version: "0.0.1",
});

registerTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers speak JSON-RPC on stdout/stdin; all logging must go to stderr.
  if (!hasSession()) {
    console.error(
      "[zalo-personal-mcp] No session found. Run `npm run login` to authenticate; " +
        "tools will error until then.",
    );
  }
  console.error("[zalo-personal-mcp] running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
