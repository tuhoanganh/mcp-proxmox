#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, parseShellIdentity } from "../dist/config.js";
import { OUTPUT_CAP_BYTES } from "../dist/node-shell.js";
import { ProxmoxClient } from "../dist/proxmox.js";
import { registerShellTools } from "../dist/tools/shell.js";

const includeWrongPassword = process.argv.includes("--include-wrong-password");
const totpFlag = process.argv.indexOf("--totp-command");
const totpCommand = totpFlag < 0 ? undefined : process.argv[totpFlag + 1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function refuse(message) {
  process.stderr.write(`verify-node-shell: ${message}\n`);
  process.exit(2);
}

if (totpFlag >= 0 && !totpCommand) refuse("--totp-command needs a command that prints the current 6-digit code.");

let config;
try {
  config = loadConfig();
} catch (e) {
  refuse(e instanceof SyntaxError ? "config.json is not valid JSON." : e.message);
}
const parsed = parseShellIdentity(config);
if (parsed.status === "invalid") refuse(`the shell block in config.json is unusable: ${parsed.reason}`);
if (parsed.status === "absent") {
  refuse(
    'config.json has no usable shell identity. Add a "shell" block (root@pam, or a Linux user with a password) ' +
      "or log in with the root@pam password, then run again. Nothing was sent to the cluster."
  );
}
const { identity } = parsed;

const client = new ProxmoxClient(config);
const termproxyPorts = [];
client.http.interceptors.response.use((res) => {
  if (res.config.url?.endsWith("/termproxy")) termproxyPorts.push(res.data.data.port);
  return res;
});

const rows = [];
const taskOutcomes = [];
let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    rows.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } catch (e) {
    failures++;
    rows.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
}

const upidNode = (upid) => upid.split(":")[1];
let apiNode;

async function settleTask(upid) {
  const node = apiNode ?? upidNode(upid);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await client.getTaskStatus(node, upid);
    if (status.status === "stopped") {
      taskOutcomes.push({ upid, node, exitstatus: status.exitstatus });
      return `task stopped, exitstatus ${status.exitstatus}`;
    }
    assert.ok(Date.now() < deadline, `vncshell task ${upid} still running on ${node} 15 s after the call returned`);
    await sleep(500);
  }
}

async function shellCase(name, run, verify) {
  await check(name, async () => {
    const started = Date.now();
    const r = await run();
    verify(r, Date.now() - started);
    return `exit ${r.exitCode}, ${Date.now() - started} ms, ${await settleTask(r.upid)}`;
  });
}

const nodes = (await client.listNodes()).filter((n) => n.status === "online").map((n) => n.node).sort();
if (nodes.length === 0) refuse("the cluster reports no online node.");

let lastCode;
async function askTotpCode() {
  const deadline = Date.now() + 35_000;
  for (;;) {
    const run = spawnSync(totpCommand, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    assert.equal(run.status, 0, `--totp-command exited with status ${run.status}`);
    const code = run.stdout.trim();
    assert.match(code, /^\d{6}$/, "--totp-command did not print a 6-digit code");
    if (code !== lastCode || Date.now() >= deadline) {
      lastCode = code;
      return code;
    }
    await sleep(1000);
  }
}

const exec = (c, node, command, timeoutS = 30) =>
  c.nodeShell(node, command, timeoutS, { askTotpCode: totpCommand ? askTotpCode : undefined });

await shellCase(
  `echo hello on ${nodes[0]}`,
  async () => {
    const r = await exec(client, nodes[0], "echo hello");
    apiNode = upidNode(r.upid);
    return r;
  },
  (r) => {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "hello\n");
    assert.equal(r.stderr, "");
  }
);
if (!apiNode) {
  console.log("\nThe first call failed, so the API host node is unknown. Stopping.");
  process.exit(1);
}
console.log(`      API host node: ${apiNode}${apiNode === nodes[0] ? "" : ` (the call above went through the SSH hop to ${nodes[0]})`}`);

await shellCase(
  "exit code and separate streams",
  () => exec(client, apiNode, "echo out; echo err >&2; exit 3"),
  (r) => {
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, "out\n");
    assert.equal(r.stderr, "err\n");
  }
);

const script = [
  "name='wor ld'",
  'echo "hello $name, home is ${HOME:+set}"',
  "echo 'single \"double\" $notexpanded'",
  'echo "bang! !! done!"',
  "cat <<'EOF'",
  'heredoc "quoted" $HOME `not run`',
  "EOF",
  "for i in 1 2 3; do printf '%s,' \"$i\"; done; echo",
].join("\n");
const local = spawnSync("bash", ["-c", script], { encoding: "buffer" }).stdout;
await shellCase(
  "quoting script matches a local bash run byte for byte",
  () => exec(client, apiNode, script),
  (r) => {
    assert.equal(r.exitCode, 0);
    assert.deepEqual(Buffer.from(r.stdout), local);
  }
);

await shellCase(
  "binary bytes",
  () => exec(client, apiNode, "printf 'h\\xc3\\xa9\\x00\\xff'"),
  (r) => {
    assert.equal(r.stdout, "hé\u0000�");
    assert.equal(r.stdoutBytes, 5);
  }
);

await shellCase(
  "output over the cap is truncated to 32 KiB",
  () => exec(client, apiNode, "seq 1 200000"),
  (r) => {
    assert.equal(r.stdoutBytes, 1288895);
    assert.equal(Buffer.byteLength(r.stdout), OUTPUT_CAP_BYTES);
  }
);

await shellCase(
  "node-side timeout returns 124 in under 10 s",
  () => exec(client, apiNode, "sleep 30", 2),
  (r, ms) => {
    assert.equal(r.exitCode, 124);
    assert.ok(ms < 10_000, `took ${ms} ms`);
  }
);

const remote = nodes.find((n) => n !== apiNode);
if (remote) {
  await shellCase(
    `echo hello on ${remote}, a node other than the API host`,
    () => exec(client, remote, "echo hello"),
    (r) => {
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, "hello\n");
    }
  );
} else {
  console.log("SKIP  remote node case: the cluster has one online node");
}

await check("5 parallel calls all pass, each on its own termproxy port", async () => {
  termproxyPorts.length = 0;
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => exec(client, apiNode, `echo call-${i}`)));
  results.forEach((r, i) => {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, `call-${i + 1}\n`);
  });
  assert.equal(new Set(results.map((r) => r.upid)).size, 5, "task ids are not distinct");
  assert.equal(new Set(termproxyPorts).size, 5, `termproxy ports were ${termproxyPorts.join(",")}`);
  const settled = [];
  for (const r of results) settled.push(await settleTask(r.upid));
  return settled[0];
});

if (identity.kind === "linux") {
  const withSudo = (sudo) => {
    const extra = new ProxmoxClient({ ...config, shell: { ...config.shell, sudo } });
    extra.shellSession = client.shellSession;
    return extra;
  };
  await shellCase(
    "id -un with sudo on is root",
    () => exec(withSudo(true), apiNode, "id -un"),
    (r) => assert.equal(r.stdout, "root\n")
  );
  await shellCase(
    "id -un with sudo off is the Linux user",
    () => exec(withSudo(false), apiNode, "id -un"),
    (r) => assert.equal(r.stdout, `${identity.username}\n`)
  );
} else {
  await shellCase(
    "id -un as the root identity",
    () => exec(client, apiNode, "id -un"),
    (r) => assert.equal(r.stdout, "root\n")
  );
}

await shellCase(
  "an expired shell ticket is renewed and the next call succeeds",
  async () => {
    const store = client.shellSession ?? client.mainSession;
    const before = store.current().ticket;
    store.current().expiresAt = 0;
    await sleep(1100);
    const r = await exec(client, apiNode, "echo renewed");
    assert.notEqual(store.current().ticket, before, "the ticket did not change");
    return r;
  },
  (r) => assert.equal(r.stdout, "renewed\n")
);

await check("a token config without a shell block does not register node_shell", async () => {
  const tokenOnly = new ProxmoxClient({
    host: config.host,
    port: config.port,
    insecure: config.insecure,
    auth: { type: "apitoken", token: "nobody@pam!none=00000000-0000-0000-0000-000000000000" },
  });
  const registered = [];
  registerShellTools({ registerTool: (name) => registered.push(name) }, tokenOnly);
  assert.equal(tokenOnly.shell.status, "absent");
  assert.deepEqual(registered, []);
  return "no request was made, so no vncshell task can appear";
});

await check("shell.user alice@pve is rejected and the message names the fix", async () => {
  const r = parseShellIdentity({ ...config, shell: { user: "alice@pve", password: "x" } });
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /Linux username/);
});

if (includeWrongPassword) {
  await check("a wrong shell password fails at the ticket request, before any termproxy task", async () => {
    const wrong = `wrong-${randomBytes(6).toString("hex")}`;
    const bad = config.shell
      ? { ...config, shell: { ...config.shell, password: wrong } }
      : { ...config, auth: { ...config.auth, password: wrong } };
    const badClient = new ProxmoxClient(bad);
    let termproxyCalls = 0;
    badClient.http.interceptors.request.use((req) => {
      if (req.url?.endsWith("/termproxy")) termproxyCalls++;
      return req;
    });
    const vncshellTasks = async () => (await client.getNodeTasks(apiNode, 100)).filter((t) => t.type === "vncshell").length;
    const before = await vncshellTasks();
    await assert.rejects(exec(badClient, apiNode, "true"), /rejected the node_shell login/);
    assert.equal(termproxyCalls, 0);
    assert.equal(await vncshellTasks(), before);
  });
} else {
  console.log("SKIP  wrong password case: pass --include-wrong-password to run it");
}

console.log("\nvncshell task outcomes");
for (const t of taskOutcomes) console.log(`  ${t.node}  ${t.upid}  exitstatus=${t.exitstatus}`);
console.log(`\n${rows.length - failures}/${rows.length} cases passed`);
process.exit(failures === 0 ? 0 : 1);
