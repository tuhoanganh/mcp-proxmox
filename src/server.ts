#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  CONFIG_FILE,
  SETUP_GUIDE,
  configExists,
  loadConfig,
  saveConfig,
  type ProxmoxConfig,
} from "./config.js";
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

function registerProxmoxTools(server: McpServer, client: ProxmoxClient) {
  registerVmTools(server, client);
  registerSnapshotTools(server, client);
  registerClusterTools(server, client);
  registerAdminTools(server, client);
  registerPoolTools(server, client);
  registerMigrationTools(server, client);
  registerCloneTools(server, client);
  registerGuestTools(server, client);
}

const setupSchema = {
  host: z.string().min(1).optional().describe("Proxmox host or IP"),
  port: z.number().int().default(8006).optional().describe("API port"),
  auth: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("apitoken"),
        token: z.string().describe("user@realm!tokenid=secret"),
      }),
      z.object({
        type: z.literal("password"),
        username: z.string().describe("user@realm, e.g. root@pam"),
        password: z.string(),
        totp: z.string().optional().describe("Base32 TOTP secret, only if 2FA is enabled"),
      }),
    ])
    .optional(),
  insecure: z.boolean().default(true).optional().describe("Skip TLS verification (self-signed certs)"),
};

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError && { isError }),
});

const str = (title: string, description?: string) => ({
  type: "string" as const,
  title,
  ...(description && { description }),
});

// Runs the two elicitation forms. Returns null if the user declined or cancelled either one.
async function elicitConfig(server: McpServer): Promise<ProxmoxConfig | null> {
  const first = await server.server.elicitInput({
    message: "Connect mcp-proxmox to your Proxmox VE host",
    requestedSchema: {
      type: "object",
      properties: {
        host: str("Proxmox host / IP"),
        port: { type: "integer", title: "API port", default: 8006 },
        auth_type: {
          type: "string",
          title: "Authentication",
          enum: ["apitoken", "password", "password_totp"],
          enumNames: ["API token (recommended)", "Username + password", "Username + password + TOTP"],
          default: "apitoken",
        },
        insecure: {
          type: "boolean",
          title: "Skip TLS verification (self-signed certificate)",
          default: true,
        },
      },
      required: ["host", "auth_type"],
    },
  });
  if (first.action !== "accept" || !first.content) return null;
  const { host, port, auth_type, insecure } = first.content as {
    host: string;
    port?: number;
    auth_type: "apitoken" | "password" | "password_totp";
    insecure?: boolean;
  };

  const fields: Record<string, ReturnType<typeof str>> =
    auth_type === "apitoken"
      ? { token: str("API token", "user@realm!tokenid=secret") }
      : {
          username: str("Username", "e.g. root@pam"),
          password: str("Password"),
          ...(auth_type === "password_totp" && { totp: str("TOTP base32 secret") }),
        };
  const second = await server.server.elicitInput({
    message: `Credentials for ${host}`,
    requestedSchema: { type: "object", properties: fields, required: Object.keys(fields) },
  });
  if (second.action !== "accept" || !second.content) return null;
  const c = second.content as Record<string, string>;

  return {
    host,
    port: port ?? 8006,
    insecure: insecure ?? true,
    auth:
      auth_type === "apitoken"
        ? { type: "apitoken", token: c.token }
        : { type: "password", username: c.username, password: c.password, totp: c.totp },
  };
}

function registerSetupTool(server: McpServer) {
  const setupTool = server.tool(
    "setup_proxmox",
    "Configure the Proxmox connection. Call with no arguments: it opens a form to collect the connection " +
      "details, and secrets entered there never pass through the model. Pass arguments (host, port, auth, " +
      "insecure) only if the client can't show forms. The connection is tested first and the config is " +
      "saved only on success.",
    setupSchema,
    async (args) => {
      let config: ProxmoxConfig;
      if (args.host && args.auth) {
        config = { host: args.host, port: args.port ?? 8006, auth: args.auth, insecure: args.insecure ?? true };
      } else if (server.server.getClientCapabilities()?.elicitation) {
        const collected = await elicitConfig(server);
        if (!collected) return text("Setup cancelled. Nothing was saved.");
        config = collected;
      } else {
        return text(
          "This client can't show forms. Use AskUserQuestion to collect host, port (default 8006), " +
            "auth type (API token, or username/password with optional TOTP secret), the credentials, and " +
            "insecure (default true), then call setup_proxmox again with those arguments. Alternatively, " +
            `the user can edit ${CONFIG_FILE} by hand.`,
          true
        );
      }
      const client = new ProxmoxClient(config);
      let v;
      try {
        v = await client.getVersion();
      } catch (e) {
        return text(`Could not connect to ${config.host}:${config.port}: ${(e as Error).message}. Config not saved.`, true);
      }
      saveConfig(config);
      registerProxmoxTools(server, client);
      setupTool.remove();
      return text(
        `Connected to ${config.host}:${config.port} (PVE ${v.version}). Config saved to ${CONFIG_FILE}. Proxmox tools are now available.`
      );
    }
  );
}

async function main() {
  const server = new McpServer({
    name: "mcp-proxmox",
    version: "1.0.0",
  });

  // Resources must be registered before connect; they don't need the client
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

  if (configExists()) {
    let config: ProxmoxConfig;
    try {
      config = loadConfig();
    } catch (e) {
      process.stderr.write(`[mcp-proxmox] ${(e as Error).message}\n`);
      process.exit(1);
    }
    const client = new ProxmoxClient(config);
    registerProxmoxTools(server, client);

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
  } else {
    process.stderr.write(`[mcp-proxmox] ${SETUP_GUIDE}\n`);
    registerSetupTool(server);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
