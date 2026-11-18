import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxmoxClient } from "../dist/proxmox.js";

process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";

let dir;
let server;
let port;
let ticketRequests = 0;
let versionCookies = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-proxmox-test-"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=127.0.0.1", "-days", "1"],
    { stdio: "ignore" }
  );
  server = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api2/json/access/ticket") {
      ticketRequests++;
      res.end(JSON.stringify({ data: { ticket: `PVE:u@pam:ticket${ticketRequests}`, CSRFPreventionToken: "csrf" } }));
    } else if (req.method === "GET" && req.url === "/api2/json/version") {
      versionCookies.push(req.headers.cookie ?? req.headers.authorization);
      res.end(JSON.stringify({ data: { version: "8.4", release: "1" } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const passwordClient = () =>
  new ProxmoxClient({ host: "127.0.0.1", port, insecure: true, auth: { type: "password", username: "u@pam", password: "pw" } });

test("a cached password ticket is reused until it expires, then replaced", async () => {
  ticketRequests = 0;
  versionCookies = [];
  const client = passwordClient();
  await client.getVersion();
  await client.getVersion();
  assert.equal(ticketRequests, 1);

  client.mainSession.current().expiresAt = 0;
  await client.getVersion();
  assert.equal(ticketRequests, 2);
  assert.deepEqual(versionCookies, [
    "PVEAuthCookie=PVE:u@pam:ticket1",
    "PVEAuthCookie=PVE:u@pam:ticket1",
    "PVEAuthCookie=PVE:u@pam:ticket2",
  ]);
});

test("concurrent calls on an expired session share one login", async () => {
  ticketRequests = 0;
  const client = passwordClient();
  await client.getVersion();
  client.mainSession.current().expiresAt = 0;
  await Promise.all([client.getVersion(), client.getVersion(), client.getVersion()]);
  assert.equal(ticketRequests, 2);
});

test("API token sessions never need a ticket request", async () => {
  ticketRequests = 0;
  const client = new ProxmoxClient({ host: "127.0.0.1", port, insecure: true, auth: { type: "apitoken", token: "u@pam!t=secret" } });
  await client.getVersion();
  assert.equal(client.mainSession.current().expiresAt, Infinity);
  assert.equal(ticketRequests, 0);
});
