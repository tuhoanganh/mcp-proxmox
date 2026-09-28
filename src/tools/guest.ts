import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProxmoxClient } from "../proxmox.js";

export function registerGuestTools(server: McpServer, client: ProxmoxClient): void {
  server.tool(
    "guest_file_write",
    "Write a file inside a running VM's guest OS via the QEMU guest agent. Requires the guest agent to be running and reachable.",
    {
      vmid: z.number().describe("VM ID"),
      node: z.string().describe("Node name"),
      path: z.string().describe("Absolute path to write inside the guest"),
      content: z.string().describe("File content to write"),
    },
    async ({ vmid, node, path, content }) => {
      try {
        await client.guestFileWrite(node, vmid, path, content);
        return { content: [{ type: "text", text: `Wrote ${content.length} bytes to ${path} on VM ${vmid}.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "guest_exec",
    "Run a command inside a running VM's guest OS via the QEMU guest agent, and wait for it to finish. Returns exit code plus captured stdout/stderr.",
    {
      vmid: z.number().describe("VM ID"),
      node: z.string().describe("Node name"),
      command: z.union([z.string(), z.array(z.string())]).describe("Command to run, as a string or argv array"),
      timeout_s: z.number().optional().describe("Max seconds to wait for the command to finish (default 60)"),
    },
    async ({ vmid, node, command, timeout_s }) => {
      const timeoutMs = (timeout_s ?? 60) * 1000;
      const pollMs = 1000;
      try {
        const pid = await client.guestExec(node, vmid, command);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const status = await client.guestExecStatus(node, vmid, pid);
          if (status.exited) {
            const out = status["out-data"] ?? "";
            const err = status["err-data"] ?? "";
            return {
              content: [{ type: "text", text: `Exit code: ${status.exitcode ?? "unknown"}\nstdout:\n${out}\nstderr:\n${err}` }],
              isError: status.exitcode !== 0,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        return {
          content: [{ type: "text", text: `guest_exec timed out after ${timeout_s ?? 60}s waiting for pid ${pid} on VM ${vmid}.` }],
          isError: true,
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
