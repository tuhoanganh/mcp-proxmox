import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseShellIdentity } from "../dist/config.js";
import { NodeShellError } from "../dist/node-shell.js";
import { registerShellTools } from "../dist/tools/shell.js";

const token = { type: "apitoken", token: "tu@pam!t=secret" };
const config = (shell) => ({ host: "h", port: 8006, auth: token, shell });

async function connect(shellBlock, nodeShell = async () => ({})) {
  const server = new McpServer({ name: "t", version: "0" });
  const calls = [];
  const client = {
    shell: parseShellIdentity(config(shellBlock)),
    nodeShell: async (...args) => {
      calls.push(args);
      return nodeShell(...args);
    },
  };
  registerShellTools(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, calls };
}

const toolNames = async (mcp) => (mcp.getServerCapabilities()?.tools ? (await mcp.listTools()).tools.map((t) => t.name) : []);

const captureStderr = () => {
  const lines = [];
  const spy = mock.method(process.stderr, "write", (s) => (lines.push(String(s)), true));
  return { lines, restore: () => spy.mock.restore() };
};

test("a token config without a shell block does not register node_shell and logs nothing", async () => {
  const err = captureStderr();
  const { mcp } = await connect(undefined);
  err.restore();
  assert.deepEqual(await toolNames(mcp), []);
  assert.deepEqual(err.lines, []);
});

test("an invalid shell block logs one disabled line and registers nothing", async () => {
  const err = captureStderr();
  const { mcp } = await connect({ user: "alice@pve", password: "hunter2" });
  err.restore();
  assert.deepEqual(await toolNames(mcp), []);
  assert.equal(err.lines.length, 1);
  assert.match(err.lines[0], /^\[mcp-proxmox\] node_shell disabled: .*Linux username.*\n$/);
  assert.doesNotMatch(err.lines[0], /hunter2/);
});

test("the description says who the commands run as", async () => {
  const describe = async (shell) => (await (await connect(shell)).mcp.listTools()).tools[0].description;
  assert.match(await describe({ user: "root@pam", password: "x" }), /as root on a Proxmox node/);
  assert.match(await describe({ user: "alice", password: "x" }), /as root on a Proxmox node/);
  assert.match(await describe({ user: "alice", password: "x", sudo: false }), /as alice on a Proxmox node/);
});

test("the tool is flagged destructive and advertises its input limits", async () => {
  const [tool] = (await (await connect({ password: "x" })).mcp.listTools()).tools;
  assert.equal(tool.name, "node_shell");
  assert.equal(tool.annotations.destructiveHint, true);
  assert.deepEqual(tool.inputSchema.required.sort(), ["command", "node"]);
  assert.equal(tool.inputSchema.properties.command.maxLength, 8192);
  assert.equal(tool.inputSchema.properties.timeout_s.maximum, 600);
});

test("a successful call returns exit code, stdout, stderr and the task, with the default timeout", async () => {
  const { mcp, calls } = await connect({ password: "x" }, async () => ({
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    stdoutBytes: 6,
    stderrBytes: 0,
    upid: "UPID:pve1:1:2:3:vncshell::root@pam:",
  }));
  const r = await mcp.callTool({ name: "node_shell", arguments: { node: "pve1", command: "echo hello" } });
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "Exit code: 0\nstdout:\nhello\n\nstderr:\n\nTask: UPID:pve1:1:2:3:vncshell::root@pam:");
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["pve1", "echo hello", 60]]);
});

test("a non-zero exit is an error and truncation is stated", async () => {
  const { mcp } = await connect({ password: "x" }, async () => ({
    exitCode: 3,
    stdout: "x".repeat(10),
    stderr: "err\n",
    stdoutBytes: 1288895,
    stderrBytes: 4,
    upid: "UPID:u",
  }));
  const r = await mcp.callTool({ name: "node_shell", arguments: { node: "pve1", command: "seq 1 200000", timeout_s: 5 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Exit code: 3\n/);
  assert.match(r.content[0].text, /\[stdout truncated: showing the first 32768 of 1288895 bytes\]/);
  assert.doesNotMatch(r.content[0].text, /stderr truncated/);
});

test("a shell failure names its phase and a plain failure passes its message through", async () => {
  let failure = new NodeShellError("awaiting_shell", "No shell answered on pve1 within 20 s.");
  const { mcp } = await connect({ password: "x" }, async () => {
    throw failure;
  });
  const args = { name: "node_shell", arguments: { node: "pve1", command: "true" } };
  let r = await mcp.callTool(args);
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Error: node_shell failed in phase awaiting_shell: No shell answered on pve1 within 20 s.");

  failure = new Error("Permission denied: root@pam needs Sys.Console on /nodes/pve1 to open a terminal.");
  r = await mcp.callTool(args);
  assert.equal(r.content[0].text, "Error: Permission denied: root@pam needs Sys.Console on /nodes/pve1 to open a terminal.");
});

test("inputs outside the schema never reach the client", async () => {
  const { mcp, calls } = await connect({ password: "x" });
  const attempt = async (args) => {
    try {
      const r = await mcp.callTool({ name: "node_shell", arguments: args });
      return r.isError === true;
    } catch {
      return true;
    }
  };
  assert.ok(await attempt({ node: "../etc", command: "true" }));
  assert.ok(await attempt({ node: "pve1", command: "" }));
  assert.ok(await attempt({ node: "pve1", command: "x".repeat(8193) }));
  assert.ok(await attempt({ node: "pve1", command: "true", timeout_s: 601 }));
  assert.ok(await attempt({ node: "pve1", command: "true", timeout_s: 0 }));
  assert.ok(await attempt({ node: "pve1", command: "true", timeout_s: 1.5 }));
  assert.deepEqual(calls, []);
});
