import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { ProxmoxClient } from "../dist/proxmox.js";
import { NodeShellError } from "../dist/node-shell.js";
import { createNodeBehavior, isCommandFrame } from "./fake-node.mjs";
import { startTlsServer } from "./tls-server.mjs";

let pve;
let log;
let makeBehavior;
let nextLoginTicket;
let termproxyReply;
let wsMode;

const resetLog = () => {
  log = { logins: [], termproxy: [], upgrades: [], wsFirstFrames: [], wsCloseCodes: [], wsInputs: [] };
  nextLoginTicket = 1;
  termproxyReply = null;
  wsMode = "normal";
};

const userOf = (cookie) => /^PVEAuthCookie=PVE:([^:]+):/.exec(cookie ?? "")?.[1];

before(async () => {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("binary") ? "binary" : false) });
  wss.on("connection", (ws) => {
    ws.on("close", (code) => log.wsCloseCodes.push(code));
    if (wsMode === "hangup") {
      ws.close(1011);
      return;
    }
    const behavior = makeBehavior();
    let first = true;
    ws.on("message", (data) => {
      const text = data.toString("utf8");
      if (first) log.wsFirstFrames.push(text);
      else log.wsInputs.push(text);
      first = false;
      behavior.handle(text, (reply) => ws.send(Buffer.from(reply, "latin1")));
    });
  });

  pve = await startTlsServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api2/json/access/ticket") {
        const form = new URLSearchParams(body);
        log.logins.push(form.get("username"));
        if (form.get("password") === "needs-totp") {
          res.end(JSON.stringify({ data: { ticket: "PVECHALLENGE:root@pam:tfa", CSRFPreventionToken: "csrf-1" } }));
          return;
        }
        if (form.get("password") === "needs-tfa") {
          res.end(JSON.stringify({ data: { NeedTFA: 1, ticket: "PVE:root@pam:CHALLENGE!tfa!{}", CSRFPreventionToken: "csrf-1" } }));
          return;
        }
        if (form.get("password") === "wrong") {
          res.statusCode = 401;
          res.end("{}");
          return;
        }
        res.end(
          JSON.stringify({ data: { ticket: `PVE:${form.get("username")}:LOGIN${nextLoginTicket++}`, CSRFPreventionToken: "csrf-1" } })
        );
      } else if (req.method === "POST" && req.url === "/api2/json/nodes/pve2/termproxy") {
        log.termproxy.push({ cookie: req.headers.cookie, csrf: req.headers.csrfpreventiontoken, authorization: req.headers.authorization });
        if (termproxyReply) {
          res.statusCode = termproxyReply.status;
          res.end(JSON.stringify(termproxyReply.body));
          return;
        }
        const user = userOf(req.headers.cookie);
        res.end(
          JSON.stringify({ data: { user, ticket: "PVE:" + user + ":TERM+/=", port: 5901, upid: `UPID:pve1:00:00:00:vncshell::${user}:` } })
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  pve.server.on("upgrade", (req, socket, head) => {
    log.upgrades.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, protocol: req.headers["sec-websocket-protocol"] });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
});

after(() => pve.close());
beforeEach(resetLog);
const serverSawEveryClose = async () => {
  for (let i = 0; i < 200 && log.wsCloseCodes.length < log.upgrades.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
afterEach(serverSawEveryClose);

const tokenAuth = { type: "apitoken", token: "tu.hoang@pam!tu.hoang=secret-token" };
const rootShell = { user: "root@pam", password: "rootpw" };
const makeClient = (shell, auth = tokenAuth) =>
  new ProxmoxClient({ host: "127.0.0.1", port: pve.port, insecure: true, auth, shell });
const serveAs = (client, execute) => {
  makeBehavior = () => createNodeBehavior({ identity: client.shell.identity, execute });
};

test("the shell opens termproxy and the websocket with its own password ticket, never the API token", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "hi\n", err: "" }));

  const r = await client.nodeShell("pve2", "echo hi", 30);

  assert.equal(r.stdout, "hi\n");
  assert.equal(r.exitCode, 0);
  assert.equal(r.upid, "UPID:pve1:00:00:00:vncshell::root@pam:");
  assert.deepEqual(log.logins, ["root@pam"]);
  assert.deepEqual(log.termproxy, [
    { cookie: "PVEAuthCookie=PVE:root@pam:LOGIN1", csrf: "csrf-1", authorization: undefined },
  ]);
  assert.equal(log.upgrades.length, 1);
  assert.equal(log.upgrades[0].url, "/api2/json/nodes/pve2/vncwebsocket?port=5901&vncticket=PVE%3Aroot%40pam%3ATERM%2B%2F%3D");
  assert.equal(log.upgrades[0].cookie, "PVEAuthCookie=PVE:root@pam:LOGIN1");
  assert.equal(log.upgrades[0].authorization, undefined);
  assert.equal(log.upgrades[0].protocol, "binary");
  assert.equal(log.wsFirstFrames[0], "root@pam:PVE:root@pam:TERM+/=\n");
});

test("the client closes the websocket normally once it has the result", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  await client.nodeShell("pve2", "true", 30);
  await serverSawEveryClose();
  assert.deepEqual(log.wsCloseCodes, [1000]);
});

test("a root@pam password login as the main auth is reused without a second login", async () => {
  const client = makeClient(undefined, { type: "password", username: "root@pam", password: "rootpw" });
  serveAs(client, () => ({ rc: 0, out: "x", err: "" }));
  await client.getVersion().catch(() => {});
  await client.nodeShell("pve2", "true", 30);
  assert.deepEqual(log.logins, ["root@pam"]);
});

test("a linux user logs in as alice@pam, answers the prompts, and runs through sudo", async () => {
  const client = makeClient({ user: "alice", password: "alicepw" });
  serveAs(client, () => ({ rc: 0, out: "root\n", err: "" }));

  const r = await client.nodeShell("pve2", "id -un", 30);

  assert.equal(r.stdout, "root\n");
  assert.deepEqual(log.logins, ["alice@pam"]);
  assert.equal(log.wsFirstFrames[0], "alice@pam:PVE:alice@pam:TERM+/=\n");
  assert.ok(log.wsInputs.some((f) => f === "0:6:alice\n"));
  assert.ok(log.wsInputs.some((f) => f === "0:8:alicepw\n"));
  assert.equal(log.wsInputs.filter(isCommandFrame).length, 1);
});

test("a wrong shell password fails at the ticket request, before any termproxy call", async () => {
  const client = makeClient({ user: "alice", password: "wrong" });
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  await assert.rejects(client.nodeShell("pve2", "true", 30), /rejected the node_shell login for alice@pam \(HTTP 401\)/);
  assert.equal(log.termproxy.length, 0);
  assert.equal(log.upgrades.length, 0);
});

test("a shell identity that needs TOTP without a secret is pointed at shell.totp", async () => {
  const client = makeClient({ user: "root@pam", password: "needs-totp" });
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  await assert.rejects(
    client.nodeShell("pve2", "true", 30),
    (e) =>
      e.message === "Proxmox requires a TOTP code for root@pam. Add shell.totp (the base32 secret) to config.json." &&
      !e.message.includes("mcp-proxmox-setup")
  );
  assert.equal(log.termproxy.length, 0);
});

test("a shell identity answering NeedTFA without a secret is pointed at shell.totp", async () => {
  const client = makeClient({ user: "root@pam", password: "needs-tfa" });
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  await assert.rejects(
    client.nodeShell("pve2", "true", 30),
    (e) => e.message === "Proxmox requires a TOTP code for root@pam. Add shell.totp (the base32 secret) to config.json."
  );
  assert.equal(log.termproxy.length, 0);
});

test("a 403 from termproxy tells the user which privilege is missing", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  termproxyReply = { status: 403, body: { errors: { "": "Permission check failed" } } };
  await assert.rejects(client.nodeShell("pve2", "true", 30), /needs Sys\.Console on \/nodes\/pve2/);
  assert.equal(log.upgrades.length, 0);
});

test("an expired shell ticket is replaced on the next call", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  await client.nodeShell("pve2", "true", 30);
  client.shellSession.current().expiresAt = 0;
  await client.nodeShell("pve2", "true", 30);
  assert.deepEqual(
    log.termproxy.map((t) => t.cookie),
    ["PVEAuthCookie=PVE:root@pam:LOGIN1", "PVEAuthCookie=PVE:root@pam:LOGIN2"]
  );
});

test("a server that hangs up before OK rejects in the authenticating phase", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "", err: "" }));
  wsMode = "hangup";
  await assert.rejects(client.nodeShell("pve2", "true", 30), (e) => e instanceof NodeShellError && e.phase === "authenticating");
});

test("five parallel calls each get their own session", async () => {
  const client = makeClient(rootShell);
  serveAs(client, () => ({ rc: 0, out: "ok", err: "" }));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.nodeShell("pve2", "true", 30)).map((p) => p.catch((e) => e)));
  assert.ok(results.every((r) => r.stdout === "ok"), results.map(String).join("|"));
  assert.deepEqual(log.logins, ["root@pam"]);
  assert.equal(log.upgrades.length, 5);
});
