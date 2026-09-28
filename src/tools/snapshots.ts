import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerSnapshotTools(server: McpServer, client: ProxmoxClient): void {
  // ── list_snapshots ────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "list_snapshots",
    {
      description:
        "List all snapshots for a VM or container. Opens an interactive snapshot browser.",
      annotations: { title: "Browse Snapshots", readOnlyHint: true },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/snapshot-picker.html" } },
    },
    async ({ vmid, node, type }) => {
      const snaps = await client.listSnapshots(node, vmid, type);
      return {
        content: [{ type: "text", text: JSON.stringify({ vmid, node, type, snapshots: snaps }) }],
      };
    }
  );

  // ── create_snapshot ───────────────────────────────────────────────────────
  registerAppTool(
    server,
    "create_snapshot",
    {
      description:
        "Create a snapshot for a VM or container. Opens a form to enter snapshot details.",
      annotations: { title: "Create Snapshot" },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/snapshot-form.html" } },
    },
    async ({ vmid, node, type }) => {
      return {
        content: [{ type: "text", text: JSON.stringify({ vmid, node, type, mode: "create" }) }],
      };
    }
  );

  // ── create_snapshot_execute ───────────────────────────────────────────────
  server.tool(
    "create_snapshot_execute",
    "Execute snapshot creation after the user fills in the form via create_snapshot.",
    {
      vmid: z.number(),
      node: z.string(),
      type: z.enum(["qemu", "lxc"]),
      name: z.string().describe("Snapshot name (no spaces)"),
      description: z.string().optional(),
      vmstate: z.boolean().optional().describe("Include RAM state (QEMU only)"),
    },
    async ({ vmid, node, type, name, description, vmstate }) => {
      try {
        const upid = await client.createSnapshot(node, vmid, type, name, description, vmstate);
        return {
          content: [{ type: "text", text: `Snapshot '${name}' creation started. Task ID: ${upid}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── rollback_snapshot ─────────────────────────────────────────────────────
  registerAppTool(
    server,
    "rollback_snapshot",
    {
      description:
        "Roll back a VM or container to a snapshot. Shows a confirmation dialog before executing.",
      annotations: { title: "Rollback Snapshot" },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
        snapname: z.string().describe("Snapshot name to roll back to"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/vm-confirm.html" } },
    },
    async ({ vmid, node, type, snapname }) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              vmid,
              node,
              type,
              action: "rollback",
              snapname,
              name: String(vmid),
              pending: true,
            }),
          },
        ],
      };
    }
  );

  // ── rollback_snapshot_execute ─────────────────────────────────────────────
  server.tool(
    "rollback_snapshot_execute",
    "Execute snapshot rollback after user confirms via rollback_snapshot dialog.",
    {
      vmid: z.number(),
      node: z.string(),
      type: z.enum(["qemu", "lxc"]),
      snapname: z.string(),
    },
    async ({ vmid, node, type, snapname }) => {
      try {
        const upid = await client.rollbackSnapshot(node, vmid, type, snapname);
        return {
          content: [{ type: "text", text: `Rollback to '${snapname}' started. Task ID: ${upid}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── delete_snapshot ───────────────────────────────────────────────────────
  server.tool(
    "delete_snapshot",
    "Delete a snapshot from a VM or container.",
    {
      vmid: z.number(),
      node: z.string(),
      type: z.enum(["qemu", "lxc"]),
      snapname: z.string().describe("Snapshot name to delete"),
    },
    async ({ vmid, node, type, snapname }) => {
      try {
        const upid = await client.deleteSnapshot(node, vmid, type, snapname);
        return {
          content: [{ type: "text", text: `Snapshot '${snapname}' deletion started. Task ID: ${upid}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
