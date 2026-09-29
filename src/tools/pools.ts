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

  // ── assign_vm_to_pool_execute ─────────────────────────────────────────────
  server.tool(
    "assign_vm_to_pool_execute",
    "Add one or more VMs to a Proxmox resource pool (idempotent).",
    {
      poolid: z.string().describe("Target pool id"),
      vmids: z.array(z.number()).describe("VM IDs to add to the pool"),
    },
    async ({ poolid, vmids }) => {
      try {
        await client.addVmsToPool(poolid, vmids);
        return {
          content: [
            {
              type: "text",
              text: `VM(s) ${vmids.join(", ")} added to pool "${poolid}".`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `assign_vm_to_pool failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── verify_pool_access ─────────────────────────────────────────────
  server.tool(
    "verify_pool_access",
    "Verify the authenticated Proxmox identity is authorized to allocate VMs in a pool. Resolves the current user from the credential and checks /access/permissions for VM.Allocate on /pool/<poolid>. Returns authorized=false (does not throw for an unauthorized/missing pool) so callers can STOP — pool visibility is NOT ownership.",
    {
      poolid: z.string().describe("Pool id to verify (the caller's own pool)"),
    },
    async ({ poolid }) => {
      try {
        const currentUser = await client.getCurrentUser();
        const path = `/pool/${poolid}`;
        const perms = await client.getPermissions(path);
        const p =
          (perms && (perms[path] as Record<string, number> | undefined)) ??
          (perms as unknown as Record<string, number>) ??
          {};
        const authorized = !!(p["VM.Allocate"] || p["Permissions.Modify"]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ currentUser, poolid, path, authorized, permissions: p }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ poolid, authorized: false, error: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    }
  );
}
