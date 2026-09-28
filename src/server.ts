#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { loadConfig } from "./config.js";
import { ProxmoxClient } from "./proxmox.js";
import { loadWidget, WIDGET_FILES } from "./widgets.js";
import { registerVmTools } from "./tools/vms.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerClusterTools } from "./tools/cluster.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerPoolTools } from "./tools/pools.js";
import { registerMigrationTools } from "./tools/migration.js";
import { registerCloneTools } from "./tools/clone.js";
import { registerGuestTools } from "./tools/guest.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`[mcp-proxmox] ${(e as Error).message}\n`);
    process.exit(1);
  }

  const client = new ProxmoxClient(config);

  const server = new McpServer({
    name: "mcp-proxmox",
    version: "1.0.0",
  });

  // Register all tool modules
  registerVmTools(server, client);
  registerSnapshotTools(server, client);
  registerClusterTools(server, client);
  registerAdminTools(server, client);
  registerPoolTools(server, client);
  registerMigrationTools(server, client);
  registerCloneTools(server, client);
  registerGuestTools(server, client);

  // Register UI resources for all widgets
  for (const [uri, filename] of Object.entries(WIDGET_FILES)) {
    const name = filename.replace(".html", "").replace(/-/g, " ");
    registerAppResource(server, name, uri, {}, async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadWidget(filename),
        },
      ],
    }));
  }

  // Validate connection on startup (non-fatal)
  client
    .getVersion()
    .then((v) => {
      process.stderr.write(
        `[mcp-proxmox] Connected to ${config.host}:${config.port} (PVE ${v.version}-${v.release})\n`
      );
    })
    .catch((e) => {
      process.stderr.write(`[mcp-proxmox] Warning: ${(e as Error).message}\n`);
    });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
