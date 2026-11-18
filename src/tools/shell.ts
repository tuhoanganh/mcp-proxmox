import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProxmoxClient } from "../proxmox.js";
import type { ShellIdentity } from "../config.js";
import { NodeShellError, OUTPUT_CAP_BYTES, type ShellResult } from "../node-shell.js";

const DEFAULT_TIMEOUT_S = 60;

const runsAs = (identity: ShellIdentity) =>
  identity.kind === "root" || identity.sudo ? "root" : identity.username;

const truncationNote = (stream: string, bytes: number) =>
  bytes > OUTPUT_CAP_BYTES ? [`[${stream} truncated: showing the first ${OUTPUT_CAP_BYTES} of ${bytes} bytes]`] : [];

export function formatShellResult(r: ShellResult): string {
  return [
    `Exit code: ${r.exitCode}`,
    `stdout:\n${r.stdout}`,
    `stderr:\n${r.stderr}`,
    ...truncationNote("stdout", r.stdoutBytes),
    ...truncationNote("stderr", r.stderrBytes),
    `Task: ${r.upid}`,
  ].join("\n");
}

export function registerShellTools(server: McpServer, client: ProxmoxClient): void {
  const { shell } = client;
  if (shell.status === "invalid") {
    process.stderr.write(`[mcp-proxmox] node_shell disabled: ${shell.reason}\n`);
    return;
  }
  if (shell.status === "absent") return;

  server.registerTool(
    "node_shell",
    {
      title: "Node Shell",
      description:
        `Run a non-interactive bash script as ${runsAs(shell.identity)} on a Proxmox node, through the same ` +
        "termproxy session the web UI Shell button opens. Each call opens a fresh login shell, so the working " +
        "directory and variables do not carry over between calls. Stdin is /dev/null and there is no TTY, so use " +
        "batch flags (top -b, apt-get -y). Returns the exit code and separate stdout and stderr, each capped at " +
        `${OUTPUT_CAP_BYTES / 1024} KiB. Exit code 124 means the timeout fired on the node. Each call appears as a ` +
        "vncshell task in the task log.",
      inputSchema: {
        node: z
          .string()
          .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
          .describe("Node name"),
        command: z.string().min(1).max(8192).describe("Bash script to run on the node"),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe(`Seconds before the node kills the command (default ${DEFAULT_TIMEOUT_S})`),
      },
      annotations: { title: "Node Shell", destructiveHint: true },
    },
    async ({ node, command, timeout_s }) => {
      try {
        const r = await client.nodeShell(node, command, timeout_s ?? DEFAULT_TIMEOUT_S);
        return { content: [{ type: "text", text: formatShellResult(r) }], isError: r.exitCode !== 0 };
      } catch (e) {
        const message =
          e instanceof NodeShellError
            ? `node_shell failed in phase ${e.phase}: ${e.message}`
            : (e as Error).message;
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );
}
