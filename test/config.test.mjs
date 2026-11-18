import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShellIdentity } from "../dist/config.js";

const token = { type: "apitoken", token: "tu@pam!t=secret" };
const rootPassword = { type: "password", username: "root@pam", password: "main-pw" };
const base = (auth, shell) => ({ host: "h", port: 8006, auth, ...(shell && { shell }) });

test("no shell block and a token: node_shell stays off without an error", () => {
  assert.deepEqual(parseShellIdentity(base(token)), { status: "absent" });
});

test("no shell block and a non-root password login: node_shell stays off", () => {
  const auth = { type: "password", username: "alice@pam", password: "x" };
  assert.deepEqual(parseShellIdentity(base(auth)), { status: "absent" });
});

test("no shell block and a root@pam password login reuses it as the root identity", () => {
  assert.deepEqual(parseShellIdentity(base(rootPassword)), {
    status: "enabled",
    identity: { kind: "root", auth: rootPassword },
  });
});

test("a root@pam shell block opens termproxy with root's own password and TOTP", () => {
  const r = parseShellIdentity(base(token, { user: "root@pam", password: "pw", totp: "JBSWY3DP" }));
  assert.deepEqual(r, {
    status: "enabled",
    identity: { kind: "root", auth: { type: "password", username: "root@pam", password: "pw", totp: "JBSWY3DP" } },
  });
});

test("a shell block without user means root, and a bare root means root", () => {
  for (const shell of [{ password: "pw" }, { user: "root", password: "pw" }]) {
    const r = parseShellIdentity(base(token, shell));
    assert.equal(r.status, "enabled");
    assert.equal(r.identity.kind, "root");
    assert.equal(r.identity.auth.username, "root@pam");
  }
});

test("the shell block wins over a root@pam main login", () => {
  const r = parseShellIdentity(base(rootPassword, { user: "alice", password: "pw" }));
  assert.equal(r.identity.kind, "linux");
  assert.equal(r.identity.auth.password, "pw");
});

test("alice@pam and alice both become the Linux user alice with sudo on by default", () => {
  for (const user of ["alice@pam", "alice"]) {
    const r = parseShellIdentity(base(token, { user, password: "pw" }));
    assert.deepEqual(r, {
      status: "enabled",
      identity: {
        kind: "linux",
        username: "alice",
        auth: { type: "password", username: "alice@pam", password: "pw" },
        sudo: true,
      },
    });
  }
});

test("sudo false is kept", () => {
  const r = parseShellIdentity(base(token, { user: "alice", password: "pw", sudo: false }));
  assert.equal(r.identity.sudo, false);
});

test("alice@pve is rejected with a message that names the fix and not the password", () => {
  const r = parseShellIdentity(base(token, { user: "alice@pve", password: "hunter2-secret" }));
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /realm "pve"/);
  assert.match(r.reason, /Linux username/);
  assert.doesNotMatch(r.reason, /hunter2-secret/);
});

test("invalid blocks are reported, never thrown", () => {
  const cases = [
    { user: "alice", password: "" },
    { user: "alice" },
    { user: "alice", password: "pw", sudo: "yes" },
    { user: "alice", password: "pw", totp: 123456 },
    { user: "", password: "pw" },
    { user: "al ice", password: "pw" },
    { user: "alice\nroot", password: "pw" },
    "root",
  ];
  for (const shell of cases) {
    const r = parseShellIdentity(base(token, shell));
    assert.equal(r.status, "invalid", JSON.stringify(shell));
    assert.ok(r.reason.length > 0);
  }
});
