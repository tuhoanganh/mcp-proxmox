import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { ProxmoxClient } from "../proxmox.js";

export function registerVmTools(server: McpServer, client: ProxmoxClient): void {
  // ── list_vms ──────────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "list_vms",
    {
      description:
        "List all VMs and LXC containers across the Proxmox cluster, optionally filtered by pool. Opens an interactive picker to select a VM.",
      annotations: { title: "Browse VMs", readOnlyHint: true },
      inputSchema: {
        node: z.string().optional().describe("Filter by node name"),
        status: z
          .enum(["running", "stopped", "all"])
          .optional()
          .default("all")
          .describe("Filter by status"),
        type: z.enum(["qemu", "lxc", "all"]).optional().default("all").describe("Filter by type"),
        pool: z.string().optional().describe("Filter by pool ID"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/vm-picker.html" } },
    },
    async ({ node, status, type, pool }) => {
      const vms = await client.listVMs(node);
      let vmList = vms;
      if (pool) {
        const poolDetail = await client.getPool(pool).catch(() => null);
        if (poolDetail) {
          const poolVmIds = new Set(
            poolDetail.members.filter((m) => m.vmid).map((m) => m.vmid!)
          );
          vmList = vms.filter((v) => poolVmIds.has(v.vmid));
        }
      }
      const filtered = vmList.filter((v) => {
        if (status !== "all" && v.status !== status) return false;
        if (type !== "all" && v.type !== type) return false;
        return true;
      });
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
      };
    }
  );

  // ── vm_action ─────────────────────────────────────────────────────────────
  registerAppTool(
    server,
    "vm_action",
    {
      description:
        "Perform a lifecycle action on a VM or container (start, stop, reboot, shutdown, reset, delete). Shows a confirmation dialog before executing.",
      annotations: { title: "VM Action" },
      inputSchema: {
        vmid: z.number().describe("VM/container ID"),
        node: z.string().describe("Node name"),
        type: z.enum(["qemu", "lxc"]).describe("VM type"),
        action: z
          .enum(["start", "stop", "reboot", "shutdown", "reset", "suspend", "resume", "delete"])
          .describe("Action to perform"),
        name: z.string().optional().describe("VM name (for display in confirm dialog)"),
      },
      _meta: { ui: { resourceUri: "ui://widgets/vm-confirm.html" } },
    },
    async ({ vmid, node, type, action, name }) => {
      // Return metadata for the confirm widget; actual execution happens after user confirms
      // and sends the message back to Claude, which calls vm_action_execute
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ vmid, node, type, action, name: name ?? String(vmid), pending: true }),
          },
        ],
      };
    }
  );

  // ── vm_action_execute — called after user confirms in widget ──────────────
  server.tool(
    "vm_action_execute",
    "Execute a confirmed VM lifecycle action. Only call this after the user has confirmed via the vm_action confirmation dialog.",
    {
      vmid: z.number(),
      node: z.string(),
      type: z.enum(["qemu", "lxc"]),
      action: z.enum(["start", "stop", "reboot", "shutdown", "reset", "suspend", "resume", "delete"]),
      wait: z.boolean().optional().describe("Wait for the action to finish before returning (default true)"),
      wait_for_agent: z.boolean().optional().describe("For action=start, also wait for the guest agent to answer before returning"),
    },
    async ({ vmid, node, type, action, wait, wait_for_agent }) => {
      try {
        let upid: string;
        if (action === "delete") {
          upid = await client.deleteVM(node, vmid, type);
        } else {
          upid = await client.vmAction(node, vmid, type, action);
        }
        const waited = wait !== false && (action === "start" || action === "stop");
        if (waited) {
          await client.waitForTask(node, upid);
          if (action === "start" && wait_for_agent) {
            await client.waitForGuestAgent(node, vmid);
          }
        }
        const verb = waited ? "completed" : "dispatched";
        return {
          content: [{ type: "text", text: `Action '${action}' ${verb}. Task ID: ${upid}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── set_vm_config ─────────────────────────────────────────────────────────
  server.tool(
    "set_vm_config",
    "Update QEMU VM configuration (mirrors 'qm set'). Only provided fields are changed; unspecified fields are left untouched. QEMU only.",
    {
      vmid: z.number().describe("VM ID"),
      node: z.string().describe("Node name"),
      cores: z.number().int().min(1).optional().describe("CPU cores per socket"),
      sockets: z.number().int().min(1).optional().describe("CPU sockets"),
      vcpus: z.number().int().min(1).optional().describe("Hotplugged vCPUs (must be <= cores*sockets)"),
      memory: z.number().int().min(16).optional().describe("RAM in MB"),
      balloon: z.number().int().min(0).optional().describe("Ballooning minimum in MB (0 disables)"),
      cpu: z.string().optional().describe("CPU type, e.g. 'host' or 'x86-64-v2-AES'"),
      numa: z.boolean().optional().describe("Enable NUMA"),
      name: z.string().optional().describe("VM name"),
      description: z.string().optional().describe("Free-form description"),
      tags: z.string().optional().describe("Semicolon-separated tags"),
      onboot: z.boolean().optional().describe("Start VM at boot"),
      protection: z.boolean().optional().describe("Protect VM from deletion"),
      agent: z.string().optional().describe("QEMU guest agent flag, e.g. '1' or 'enabled=1,fstrim_cloned_disks=1'"),
      ostype: z.string().optional().describe("OS type, e.g. 'l26', 'win11'"),
      bios: z.enum(["seabios", "ovmf"]).optional().describe("BIOS type"),
      machine: z.string().optional().describe("Machine type, e.g. 'q35' or 'pc-i440fx-8.1'"),
      boot: z.string().optional().describe("Boot order string, e.g. 'order=scsi0;net0'"),
      bootdisk: z.string().optional().describe("Legacy single-disk boot, e.g. 'scsi0'"),
      hotplug: z.string().optional().describe("Hotplug features, e.g. 'network,disk,usb'"),
      vga: z.string().optional().describe("Display type, e.g. 'std', 'qxl'"),
      scsihw: z.string().optional().describe("SCSI controller type, e.g. 'virtio-scsi-single'"),
    },
    { title: "Set VM Config" },
    async ({ vmid, node, cores, sockets, vcpus, memory, balloon, cpu, numa, name, description, tags, onboot, protection, agent, ostype, bios, machine, boot, bootdisk, hotplug, vga, scsihw }) => {
      const params: Record<string, string | number> = {};

      // Numbers pass through as-is
      if (cores !== undefined) params.cores = cores;
      if (sockets !== undefined) params.sockets = sockets;
      if (vcpus !== undefined) params.vcpus = vcpus;
      if (memory !== undefined) params.memory = memory;
      if (balloon !== undefined) params.balloon = balloon;

      // Booleans: Proxmox expects 1 / 0
      if (onboot !== undefined) params.onboot = onboot ? 1 : 0;
      if (numa !== undefined) params.numa = numa ? 1 : 0;
      if (protection !== undefined) params.protection = protection ? 1 : 0;

      // Strings: skip empty values to avoid clobbering existing config
      if (cpu !== undefined && cpu !== "") params.cpu = cpu;
      if (name !== undefined && name !== "") params.name = name;
      if (description !== undefined && description !== "") params.description = description;
      if (tags !== undefined && tags !== "") params.tags = tags;
      if (agent !== undefined && agent !== "") params.agent = agent;
      if (ostype !== undefined && ostype !== "") params.ostype = ostype;
      if (bios !== undefined) params.bios = bios;
      if (machine !== undefined && machine !== "") params.machine = machine;
      if (boot !== undefined && boot !== "") params.boot = boot;
      if (bootdisk !== undefined && bootdisk !== "") params.bootdisk = bootdisk;
      if (hotplug !== undefined && hotplug !== "") params.hotplug = hotplug;
      if (vga !== undefined && vga !== "") params.vga = vga;
      if (scsihw !== undefined && scsihw !== "") params.scsihw = scsihw;

      if (Object.keys(params).length === 0) {
        return {
          content: [{ type: "text", text: "No config fields provided; nothing changed." }],
        };
      }

      try {
        await client.updateVMConfig(node, vmid, params);
        const changedFields = Object.keys(params).join(", ");
        return {
          content: [{ type: "text", text: `VM ${vmid} on ${node}: updated ${changedFields}.` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

