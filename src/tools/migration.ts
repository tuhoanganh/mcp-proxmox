import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerMigrationTools(server: McpServer, client: ProxmoxClient): void {
  // ── migrate_vm (form widget) ──────────────────────────────────────────────
  registerAppTool(
    server,
    "migrate_vm",
    {
      description:
        "Migrate a VM or container to another node. Shows a migration form with target node selection, online/offline mode toggle, and per-node resource load. Call migrate_vm_execute after user confirms.",
      annotations: { title: "Migrate VM" },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Source node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
        name: z.string().optional().describe("VM name for display"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/migrate-form.html" } },
    },
    async ({ vmid, node, type, name }) => {
      const [nodes, status] = await Promise.all([
        client.listNodes(),
        client.getVMStatusDetail(node, vmid, type).catch(() => null),
      ]);
      const targetNodes = nodes.filter((n) => n.node !== node && n.status === "online");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              vmid,
              sourceNode: node,
              type,
              name: name ?? status?.name ?? String(vmid),
              vmStatus: status?.status,
              maxmem: status?.maxmem,
              targetNodes,
              pending: true,
            }),
          },
        ],
      };
    }
  );

  // ── migrate_vm_execute ────────────────────────────────────────────────────
  server.tool(
    "migrate_vm_execute",
    "Execute a confirmed VM migration. Only call this after the user has confirmed via the migrate_vm form.",
    {
      vmid: z.number(),
      node: z.string().describe("Source node"),
      type: z.enum(["qemu", "lxc"]),
      target: z.string().describe("Target node"),
      online: z.boolean().optional().default(false).describe("Online (live) migration"),
      withLocalDisks: z
        .boolean()
        .optional()
        .default(false)
        .describe("Migrate local disks (required for online migration with local storage)"),
    },
    async ({ vmid, node, type, target, online, withLocalDisks }) => {
      try {
        const upid = await client.migrateVM(node, vmid, type, target, online, withLocalDisks);
        return {
          content: [
            {
              type: "text",
              text: `Migration of VM ${vmid} from ${node} → ${target} started${online ? " (live)" : " (offline)"}. Task ID: ${upid}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Migration failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
