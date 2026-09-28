import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerAdminTools(server: McpServer, client: ProxmoxClient): void {
  // ── create_api_token (form widget) ────────────────────────────────────────
  registerAppTool(
    server,
    "create_api_token_form",
    {
      description:
        "Show a form to create a new Proxmox API token. Requires administrator (Sys.Modify) permission. The token secret is shown once — user must copy it.",
      annotations: { title: "Create API Token" },
      inputSchema: {
        userid: z
          .string()
          .optional()
          .describe("User to create token for (default: current user). Format: user@realm"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/token-result.html" } },
    },
    async ({ userid }) => {
      const currentUser = await client.getCurrentUser();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "form",
              userid: userid ?? currentUser,
              currentUser,
            }),
          },
        ],
      };
    }
  );

  // ── create_api_token_execute ──────────────────────────────────────────────
  registerAppTool(
    server,
    "create_api_token_execute",
    {
      description:
        "Execute API token creation after user fills in the form. Returns the token secret (shown once).",
      annotations: { title: "Create API Token (Execute)" },
      inputSchema: {
        userid: z.string().describe("User. Format: user@realm"),
        tokenid: z.string().describe("Token ID (alphanumeric and dashes)"),
        expire: z
          .number()
          .optional()
          .describe("Expiry as Unix timestamp (0 = never)"),
        privsep: z
          .boolean()
          .optional()
          .default(true)
          .describe("Privilege separation (recommended: true)"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/token-result.html" } },
    },
    async ({ userid, tokenid, expire, privsep }) => {
      try {
        const result = await client.createApiToken(userid, tokenid, expire, privsep);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mode: "result",
                userid,
                tokenid,
                full: result.full,
                value: result.value,
              }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ mode: "error", message: (e as Error).message }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
