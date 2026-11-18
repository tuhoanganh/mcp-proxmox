import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";
import { createSession, TotpRequiredError } from "../dist/auth.js";
import { startTlsServer } from "./tls-server.mjs";

const SECRET = "JBSWY3DPEHPK3PXP";
const CHALLENGE = "PVE:u@pam:CHALLENGE!tfa!{}";

let pve;
let forms;

before(async () => {
  pve = await startTlsServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      forms.push(form);
      if (!form.has("tfa-challenge")) {
        res.end(JSON.stringify({ data: { NeedTFA: 1, ticket: CHALLENGE, CSRFPreventionToken: "csrf-challenge" } }));
        return;
      }
      if (form.get("tfa-challenge") === CHALLENGE && form.get("password") === `totp:${authenticator.generate(SECRET)}`) {
        res.end(JSON.stringify({ data: { ticket: "PVE:u@pam:REAL", CSRFPreventionToken: "csrf-real" } }));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ data: null }));
    });
  });
});

after(() => pve.close());

const baseUrl = () => `https://127.0.0.1:${pve.port}/api2/json`;
const auth = (totp) => ({ type: "password", username: "u@pam", password: "pw", totp });

test("a NeedTFA reply is answered with the challenge and the TOTP code", async () => {
  forms = [];
  const session = await createSession(baseUrl(), auth(SECRET), true);
  assert.equal(session.ticket, "PVE:u@pam:REAL");
  assert.equal(session.csrf, "csrf-real");
  assert.equal(forms.length, 2);
  assert.equal(forms[1].get("username"), "u@pam");
});

test("a rejected code fails without leaking the secret, code, or ticket", async () => {
  forms = [];
  const wrong = "GEZDGNBVGY3TQOJQ";
  const code = authenticator.generate(wrong);
  await assert.rejects(createSession(baseUrl(), auth(wrong), true), (e) => {
    const text = `${e.message} ${e.stack}`;
    for (const secret of [wrong, code, CHALLENGE, "pw"]) assert.ok(!text.includes(secret), "error must not contain a credential");
    return true;
  });
});

test("NeedTFA without a configured secret raises TotpRequiredError", async () => {
  forms = [];
  await assert.rejects(createSession(baseUrl(), auth(undefined), true), TotpRequiredError);
  assert.equal(forms.length, 1);
});
