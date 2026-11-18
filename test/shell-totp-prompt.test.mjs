import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { authenticator } from "otplib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProxmoxClient } from "../dist/proxmox.js";
import { TotpRequiredError } from "../dist/auth.js";
import { registerShellTools } from "../dist/tools/shell.js";
import { createNodeBehavior } from "./fake-node.mjs";
import { startTlsServer } from "./tls-server.mjs";

const SECRET = "JBSWY3DPEHPK3PXP";
const PROMPT_MESSAGE =
  "node_shell needs a new Proxmox login for tu.hoang@pam. Enter the current 6-digit code from your authenticator app.";

let pve;
let log;
let acceptedCodes;
let nextTicket;

const reset = () => {
  log = { tickets: [], termproxy: 0 };
  acceptedCodes = new Set();
  nextTicket = 1;
};

before(async () => {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("binary") ? "binary" : false) });
  wss.on("connection", (ws) => {
    const behavior = createNodeBehavior({ identity: { kind: "linux", username: "tu.hoang" }, execute: () => ({ rc: 0, out: "root\n", err: "" }) });
    ws.on("message", (data) => behavior.handle(data.toString("utf8"), (reply) => ws.send(Buffer.from(reply, "latin1"))));
  });

  pve = await startTlsServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api2/json/access/ticket") {
        const form = new URLSearchParams(body);
        log.tickets.push(Object.fromEntries(form));
        if (!form.has("tfa-challenge")) {
          const needsTfa = form.get("password") === "tfa-pw";
          res.end(
            JSON.stringify({
              data: needsTfa
                ? { NeedTFA: 1, ticket: "PVE:tu.hoang@pam:CHALLENGE!tfa!{}", CSRFPreventionToken: "csrf-challenge" }
                : { ticket: `PVE:${form.get("username")}:LOGIN${nextTicket++}`, CSRFPreventionToken: "csrf" },
            })
          );
          return;
        }
        if (acceptedCodes.has(form.get("password"))) {
          res.end(JSON.stringify({ data: { ticket: `PVE:tu.hoang@pam:LOGIN${nextTicket++}`, CSRFPreventionToken: "csrf" } }));
          return;
        }
        res.statusCode = 401;
        res.end("{}");
      } else if (req.method === "POST" && req.url === "/api2/json/nodes/pve2/termproxy") {
        log.termproxy++;
        res.end(JSON.stringify({ data: { user: "tu.hoang@pam", ticket: "PVE:tu.hoang@pam:TERM", port: 5901, upid: "UPID:pve2:00:00:00:vncshell::tu.hoang@pam:" } }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  pve.server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
});

after(() => pve.close());
beforeEach(reset);

const tokenAuth = { type: "apitoken", token: "tu.hoang@pam!t=secret" };
const makeProxmox = (shell = { user: "tu.hoang", password: "tfa-pw" }, auth = tokenAuth) =>
  new ProxmoxClient({ host: "127.0.0.1", port: pve.port, insecure: true, auth, shell });

async function connect(proxmox, { elicit } = {}) {
  const server = new McpServer({ name: "t", version: "0" });
  registerShellTools(server, proxmox);
  const forms = [];
  const mcp = new Client({ name: "c", version: "0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  if (elicit) {
    mcp.setRequestHandler(ElicitRequestSchema, async (req) => {
      forms.push(req.params);
      return elicit(forms.length);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const run = (command = "id -un") => mcp.callTool({ name: "node_shell", arguments: { node: "pve2", command } });
  return { mcp, forms, run };
}

const answer = (code) => () => ({ action: "accept", content: { code } });
const secondSteps = () => log.tickets.filter((t) => t["tfa-challenge"]);

test("a NeedTFA user with no secret gets one form, and the typed code reaches Proxmox", async () => {
  acceptedCodes.add("totp:123456");
  const { forms, run } = await connect(makeProxmox(), { elicit: answer("123456") });

  const r = await run();

  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /^Exit code: 0\nstdout:\nroot\n/);
  assert.equal(forms.length, 1);
  assert.equal(forms[0].message, PROMPT_MESSAGE);
  assert.deepEqual(forms[0].requestedSchema, {
    type: "object",
    properties: { code: { type: "string", title: "TOTP code", minLength: 6, maxLength: 6 } },
    required: ["code"],
  });
  assert.equal(secondSteps().length, 1);
  assert.equal(secondSteps()[0].password, "totp:123456");
  assert.equal(secondSteps()[0].username, "tu.hoang@pam");
  assert.equal(log.termproxy, 1);
});

test("the code never appears in the tool result", async () => {
  acceptedCodes.add("totp:123456");
  const { run } = await connect(makeProxmox(), { elicit: answer("123456") });
  const r = await run();
  assert.doesNotMatch(JSON.stringify(r), /123456/);
});

test("declining or cancelling the form fails the call before any second step or termproxy request", async () => {
  for (const action of ["decline", "cancel"]) {
    reset();
    const { forms, run } = await connect(makeProxmox(), { elicit: () => ({ action }) });
    const r = await run();
    assert.equal(r.isError, true, action);
    assert.match(r.content[0].text, /did not log in because the TOTP prompt was cancelled or the code was not 6 digits/);
    assert.equal(forms.length, 1);
    assert.equal(secondSteps().length, 0, action);
    assert.equal(log.termproxy, 0, action);
  }
});

test("an answer that is not 6 digits fails the call before any second step or termproxy request", async () => {
  for (const code of ["12345", "1234567", "abcdef", "12 456"]) {
    reset();
    acceptedCodes.add(`totp:${code}`);
    const { forms, run } = await connect(makeProxmox(), { elicit: answer(code) });
    const r = await run();
    assert.equal(r.isError, true, code);
    assert.match(r.content[0].text, /did not log in because the TOTP prompt was cancelled or the code was not 6 digits/);
    assert.equal(forms.length, 1, code);
    assert.equal(secondSteps().length, 0, code);
    assert.equal(log.termproxy, 0, code);
  }
});

test("a client without elicitation is told to add shell.totp or use a client with forms", async () => {
  const { run } = await connect(makeProxmox());
  const r = await run();
  assert.equal(r.isError, true);
  assert.equal(
    r.content[0].text,
    "Error: Proxmox requires a TOTP code for tu.hoang@pam. Add shell.totp (the base32 secret) to config.json, or use a client that can show forms."
  );
  assert.equal(secondSteps().length, 0);
  assert.equal(log.termproxy, 0);
});

test("a rejected code is reported once, never retried, and never echoed", async () => {
  const { forms, run } = await connect(makeProxmox(), { elicit: answer("654321") });
  const r = await run();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Proxmox rejected the node_shell login for tu\.hoang@pam \(HTTP 401\) after the TOTP code was sent\. Check the password or try a fresh code\./);
  assert.doesNotMatch(JSON.stringify(r), /654321|tfa-pw/);
  assert.equal(forms.length, 1);
  assert.equal(secondSteps().length, 1);
  assert.equal(log.termproxy, 0);
});

test("a forced renewal asks again exactly once, and cached sessions do not ask", async () => {
  acceptedCodes.add("totp:111111").add("totp:222222");
  const proxmox = makeProxmox();
  const { forms, run } = await connect(proxmox, { elicit: (n) => ({ action: "accept", content: { code: n === 1 ? "111111" : "222222" } }) });

  await run();
  await run();
  assert.equal(forms.length, 1);

  proxmox.shellSession.current().expiresAt = 0;
  const r = await run();

  assert.equal(r.isError, false);
  assert.equal(forms.length, 2);
  assert.deepEqual(secondSteps().map((t) => t.password), ["totp:111111", "totp:222222"]);
});

test("concurrent first calls share one login and one form", async () => {
  acceptedCodes.add("totp:123456");
  const { forms, run } = await connect(makeProxmox(), { elicit: answer("123456") });
  const results = await Promise.all([run("a"), run("b"), run("c")]);
  assert.ok(results.every((r) => r.isError === false));
  assert.equal(forms.length, 1);
  assert.equal(secondSteps().length, 1);
});

test("a stored secret wins and no form is shown", async () => {
  acceptedCodes.add(`totp:${authenticator.generate(SECRET)}`);
  const proxmox = makeProxmox({ user: "tu.hoang", password: "tfa-pw", totp: SECRET });
  const { mcp, forms, run } = await connect(proxmox, { elicit: answer("000000") });

  const r = await run();

  assert.equal(r.isError, false);
  assert.equal(forms.length, 0);
  assert.equal(secondSteps().length, 1);
  assert.doesNotMatch((await mcp.listTools()).tools[0].description, /form asking for a TOTP code/);
});

test("the description mentions the form only when the shell identity has no secret", async () => {
  const { mcp } = await connect(makeProxmox());
  assert.match(
    (await mcp.listTools()).tools[0].description,
    / The first call, and one about every 100 minutes after, may show a form asking for a TOTP code\.$/
  );
});

test("the main login never prompts", async () => {
  const proxmox = makeProxmox({ user: "tu.hoang", password: "x" }, { type: "password", username: "tu.hoang@pam", password: "tfa-pw" });
  const { forms } = await connect(proxmox, { elicit: answer("123456") });
  await assert.rejects(proxmox.ensureSession(), TotpRequiredError);
  assert.equal(forms.length, 0);
  assert.equal(secondSteps().length, 0);
});
