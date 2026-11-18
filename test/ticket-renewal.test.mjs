import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ProxmoxClient } from "../dist/proxmox.js";
import { startTlsServer } from "./tls-server.mjs";

let pve;
let ticketRequests = 0;
let versionCookies = [];

before(async () => {
  pve = await startTlsServer((req, res) => {
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
});

after(() => pve.close());

const passwordClient = () =>
  new ProxmoxClient({ host: "127.0.0.1", port: pve.port, insecure: true, auth: { type: "password", username: "u@pam", password: "pw" } });

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
  const client = new ProxmoxClient({ host: "127.0.0.1", port: pve.port, insecure: true, auth: { type: "apitoken", token: "u@pam!t=secret" } });
  await client.getVersion();
  assert.equal(client.mainSession.current().expiresAt, Infinity);
  assert.equal(ticketRequests, 0);
});
