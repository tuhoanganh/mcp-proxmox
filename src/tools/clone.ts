import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerCloneTools(server: McpServer, client: ProxmoxClient): void {
  // ── clone_vm (form widget) ────────────────────────────────────────────────
  registerAppTool(
    server,
    "clone_vm",
    {
      description:
        "Clone a QEMU VM (full clone). Shows a form to choose new VMID, name, target node and storage. Call clone_vm_execute after user confirms.",
      annotations: { title: "Clone VM" },
      inputSchema: {
        vmid: z.number().describe("Source VM ID"),
        node: z.string().describe("Source node name"),
        name: z.string().optional().describe("Source VM name for display"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/clone-form.html" } },
    },
    async ({ vmid, node, name }) => {
      const [nodes, nextid] = await Promise.all([
        client.listNodes(),
        client.getNextId().catch(() => 0),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sourceVmid: vmid,
              sourceNode: node,
              sourceName: name ?? String(vmid),
              suggestedNewid: nextid,
              nodes: nodes.filter((n) => n.status === "online").map((n) => ({ node: n.node })),
              pending: true,
            }),
          },
        ],
      };
    }
  );

  // ── clone_vm_execute ──────────────────────────────────────────────────────
  server.tool(
    "clone_vm_execute",
    "Execute a confirmed VM clone. Only call this after the user has confirmed via the clone_vm form.",
    {
      vmid: z.number().describe("Source VM ID"),
      node: z.string().describe("Source node name"),
      newid: z.number().describe("New VM ID for the clone"),
      name: z.string().optional().describe("Name for the new VM"),
      target: z.string().optional().describe("Target node (defaults to same node)"),
      storage: z.string().optional().describe("Target storage for full clone"),
      pool: z.string().optional().describe("Pool to place the clone in (VM joins this pool at creation)"),
      wait: z.boolean().optional().describe("Wait for the clone task to finish before returning (default true)"),
    },
    async ({ vmid, node, newid, name, target, storage, pool, wait }) => {
      try {
        const upid = await client.cloneVM(node, vmid, newid, { name, target, storage, pool });
        if (wait !== false) {
          await client.waitForTask(node, upid, { timeoutMs: 20 * 60 * 1000 });
        }
        const verb = wait !== false ? "completed" : "dispatched";
        return {
          content: [
            {
              type: "text",
              text: `Clone of VM ${vmid} → new VMID ${newid} ${verb}. Task ID: ${upid}`,
            },
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        const text = msg.startsWith("Timed out") ? msg : `Clone failed: ${msg}`;
        return {
          content: [{ type: "text", text }],
          isError: true,
        };
      }
    }
  );

  // ── set_cloud_init (form widget) ──────────────────────────────────────────
  registerAppTool(
    server,
    "set_cloud_init",
    {
      description:
        "Configure cloud-init settings for a QEMU VM (ciuser, cipassword, sshkeys, ipconfig0). Shows a pre-populated form. Call set_cloud_init_execute after user confirms.",
      annotations: { title: "Set Cloud-Init" },
      inputSchema: {
        vmid: z.number().describe("VM ID"),
        node: z.string().describe("Node name"),
        name: z.string().optional().describe("VM name for display"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/cloud-init-form.html" } },
    },
    async ({ vmid, node, name }) => {
      const cfg = await client.getVMConfig(node, vmid, "qemu");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              vmid,
              node,
              name: name ?? cfg.name ?? String(vmid),
              current: {
                ciuser: cfg.ciuser ?? "",
                ipconfig0: cfg.ipconfig0 ?? "",
                sshkeys: cfg.sshkeys ? decodeURIComponent(String(cfg.sshkeys)) : "",
              },
              pending: true,
            }),
          },
        ],
      };
    }
  );

  // ── set_cloud_init_execute ────────────────────────────────────────────────
  server.tool(
    "set_cloud_init_execute",
    "Apply confirmed cloud-init settings to a QEMU VM. Only call this after the user has confirmed via the set_cloud_init form.",
    {
      vmid: z.number().describe("VM ID"),
      node: z.string().describe("Node name"),
      ciuser: z.string().optional().describe("Cloud-init user"),
      cipassword: z.string().optional().describe("Cloud-init password"),
      sshkeys: z.string().optional().describe("SSH public keys (newline-separated)"),
      ipconfig0: z.string().optional().describe("IP configuration for interface 0 (e.g. ip=dhcp)"),
    },
    async ({ vmid, node, ciuser, cipassword, sshkeys, ipconfig0 }) => {
      try {
        const params: Record<string, string> = {};
        if (ciuser !== undefined && ciuser !== "") params.ciuser = ciuser;
        if (cipassword !== undefined && cipassword !== "") params.cipassword = cipassword;
        if (sshkeys !== undefined && sshkeys !== "") params.sshkeys = encodeURIComponent(sshkeys);
        if (ipconfig0 !== undefined && ipconfig0 !== "") params.ipconfig0 = ipconfig0;
        if (Object.keys(params).length === 0) {
          return {
            content: [{ type: "text", text: "No cloud-init fields provided; nothing changed." }],
          };
        }
        await client.updateVMConfig(node, vmid, params);
        return {
          content: [
            {
              type: "text",
              text: `Cloud-init updated for VM ${vmid} on ${node}. Fields: ${Object.keys(params).join(", ")}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Cloud-init update failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
