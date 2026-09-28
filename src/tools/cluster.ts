import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerClusterTools(server: McpServer, client: ProxmoxClient): void {
  // ── get_cluster_status ────────────────────────────────────────────────────
  registerAppTool(
    server,
    "get_cluster_status",
    {
      description:
        "Get Proxmox cluster overview: node health, CPU/RAM/disk usage per node with visual charts.",
      annotations: { title: "Cluster Status", readOnlyHint: true },
      inputSchema: {},
      _meta: { ui: { resourceUri: "ui://widgets/cluster-status.html" } },
    },
    async () => {
      const [nodes, vms] = await Promise.all([
        client.listNodes(),
        client.listVMs().catch(() => []),
      ]);

      const vmCount = vms.length;
      const runningVMs = vms.filter((v) => v.status === "running");
      const runningCount = runningVMs.length;

      const topByMem = [...runningVMs]
        .sort((a, b) => (b.mem ?? 0) - (a.mem ?? 0))
        .slice(0, 10);
      const topByCpu = [...runningVMs]
        .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))
        .slice(0, 10);
      const topByDisk = [...runningVMs]
        .sort((a, b) => (b.disk ?? 0) - (a.disk ?? 0))
        .slice(0, 10);

      const summary = {
        nodes,
        vmCount,
        runningCount,
        totals: {
          cpu: nodes.reduce((a, n) => a + n.maxcpu, 0),
          mem: nodes.reduce((a, n) => a + n.maxmem, 0),
          disk: nodes.reduce((a, n) => a + n.maxdisk, 0),
          usedMem: nodes.reduce((a, n) => a + n.mem, 0),
          usedDisk: nodes.reduce((a, n) => a + n.disk, 0),
        },
        topVMs: { byMem: topByMem, byCpu: topByCpu, byDisk: topByDisk },
      };

      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  // ── get_node_tasks ────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "get_node_tasks",
    {
      description:
        "Get recent task log for a Proxmox node or all nodes. Shows task type, status, user, and timing.",
      annotations: { title: "Node Tasks", readOnlyHint: true },
      inputSchema: {
        node: z.string().optional().describe("Node name. Omit for all nodes."),
        limit: z.number().min(1).max(200).optional().default(50).describe("Max tasks to return"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/tasks.html" } },
    },
    async ({ node, limit }) => {
      const nodes = node ? [{ node }] : await client.listNodes();
      const allTasks = await Promise.all(
        nodes.map((n) => client.getNodeTasks(n.node, limit).catch(() => []))
      );
      const tasks = allTasks.flat().sort((a, b) => b.starttime - a.starttime).slice(0, limit);
      return { content: [{ type: "text", text: JSON.stringify(tasks) }] };
    }
  );
}
