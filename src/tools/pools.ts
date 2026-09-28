import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerPoolTools(server: McpServer, client: ProxmoxClient): void {
  // ── list_pools ──────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "list_pools",
    {
      description:
        "List all Proxmox resource pools with member VMs and resource usage (CPU/RAM/Disk). Opens an interactive pool browser.",
      annotations: { title: "Browse Pools", readOnlyHint: true },
      inputSchema: {
        pool: z.string().optional().describe("Filter to a specific pool ID"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/pool-browser.html" } },
    },
    async ({ pool }) => {
      const [allPools, nodes] = await Promise.all([
        client.listPools(),
        client.listNodes(),
      ]);
      const targetPools = pool ? allPools.filter((p) => p.poolid === pool) : allPools;
      const details = await Promise.all(
        targetPools.map((p) =>
          client.getPool(p.poolid).catch(() => ({ poolid: p.poolid, comment: p.comment, members: [] }))
        )
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ pools: details, nodes }) }],
      };
    }
  );

  // ── get_vm_detail ────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "get_vm_detail",
    {
      description:
        "Get full VM or container details: configuration (CPU, memory, disks, network interfaces, all settings) plus current resource usage.",
      annotations: { title: "VM Detail", readOnlyHint: true },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
        pool: z.string().optional().describe("Pool ID (for display)"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/vm-detail.html" } },
    },
    async ({ vmid, node, type, pool }) => {
      const [status, config] = await Promise.all([
        client.getVMStatusDetail(node, vmid, type).catch(() => null),
        client.getVMConfig(node, vmid, type).catch(() => ({})),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ vmid, node, type, pool, status, config }),
          },
        ],
      };
    }
  );
}
