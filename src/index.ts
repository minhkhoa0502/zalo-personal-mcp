/**
 * zalo-personal-mcp — MCP server for a personal Zalo account.
 *
 * This is a scaffold. The tool implementations are stubs until the zca-js
 * dependency audit is complete (see docs/audit/) and the login/session flow is
 * wired up. See docs/adr/0001-architecture-and-dependency-strategy.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "zalo-personal-mcp",
  version: "0.0.1",
});

// TODO: register tools once the zca-js session layer is in place.
//   - list_threads
//   - get_messages
//   - send_message
//   - mark_read
//   - send_media (later)

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers speak on stdout/stdin; log to stderr only.
  console.error("zalo-personal-mcp running (scaffold — no tools registered yet)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
