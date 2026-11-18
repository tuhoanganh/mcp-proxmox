import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeShellError,
  OUTPUT_CAP_BYTES,
  buildWrapper,
  classifyLoginOutput,
  commandLine,
  encodeInput,
  isShellReady,
  matchLoginPrompt,
  parseResult,
  phaseDeadlineMs,
  probeLine,
  runShellSession,
} from "../dist/node-shell.js";

import { b64, createNodeBehavior, decodeWrapper, frameText, result } from "./fake-node.mjs";

const NONCE = "a1b2c3d4e5f6";

describe("encodeInput", () => {
  test("frames the byte length, not the character count", () => {
    assert.equal(encodeInput("ls\n"), "0:3:ls\n");
    assert.equal(encodeInput("héllo"), "0:6:héllo");
    assert.equal(encodeInput("€"), "0:3:€");
    assert.equal(encodeInput("\u{1F600}"), "0:4:\u{1F600}");
    assert.equal(encodeInput(""), "0:0:");
  });
});

describe("parseResult", () => {
  const motd = "Linux pve 6.8.12-4-pve #1 SMP\r\n\r\nLast login: Tue Nov 18 10:00:00 2026\r\n";
  const prompt = "\x1b[?2004hroot@pve:~# ";
  const probeEcho = `printf '%s_%s\\n' MCPRDY ${NONCE}\r\n`;
  const probeRan = `MCPRDY_${NONCE}\r\n`;

  const transcriptAround = (resultLine) =>
    motd +
    prompt +
    probeEcho +
    probeRan +
    prompt +
    probeEcho +
    probeEcho +
    probeRan +
    probeRan +
    prompt +
    commandLine("echo hello", NONCE, 60).replace("\n", "\r\n") +
    "\x1b[?2004l\r" +
    resultLine +
    "\r\n" +
    prompt;

  test("finds the result in a noisy transcript with escapes, CRLF, echoes and repeated probes", () => {
    const r = parseResult(transcriptAround(result(NONCE, 0, "hello\n", "")), NONCE);
    assert.deepEqual(r, { exitCode: 0, stdout: "hello\n", stderr: "", stdoutBytes: 6, stderrBytes: 0 });
  });

  test("the echoed typed line and echoed or executed probes alone are not a result", () => {
    const noResult = transcriptAround("");
    assert.equal(parseResult(noResult, NONCE), null);
  });

  test("returns null until the end marker has arrived, then the full result", () => {
    const line = result(NONCE, 0, "hello\n", "");
    for (const cut of [10, 40, line.length - 1]) {
      assert.equal(parseResult(transcriptAround(line.slice(0, cut)), NONCE), null, `cut at ${cut}`);
    }
    assert.notEqual(parseResult(transcriptAround(line), NONCE), null);
  });

  test("a result for another nonce is ignored", () => {
    assert.equal(parseResult(result("ffffffffffff", 0, "x", ""), NONCE), null);
  });

  test("non-zero exit with separate stdout and stderr", () => {
    const r = parseResult(result(NONCE, 3, "out\n", "err\n"), NONCE);
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, "out\n");
    assert.equal(r.stderr, "err\n");
  });

  test("exit 124 is reported as is", () => {
    assert.equal(parseResult(result(NONCE, 124, "", ""), NONCE).exitCode, 124);
  });

  test("empty stdout and stderr decode to empty strings", () => {
    const line = `MCPB_${NONCE}:0:0:0:::MCPE_${NONCE}`;
    assert.deepEqual(parseResult(line, NONCE), { exitCode: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 });
  });

  test("truncated output keeps the true size and only the captured bytes", () => {
    const head = "1\n".repeat(OUTPUT_CAP_BYTES / 2);
    const r = parseResult(result(NONCE, 0, head, "", 1288895), NONCE);
    assert.equal(r.stdoutBytes, 1288895);
    assert.equal(Buffer.byteLength(r.stdout), OUTPUT_CAP_BYTES);
  });

  test("binary output decodes as UTF-8 with a replacement character for invalid bytes", () => {
    const bytes = Buffer.from([0x68, 0xc3, 0xa9, 0x00, 0xff]);
    const line = `MCPB_${NONCE}:0:5:0:${bytes.toString("base64")}::MCPE_${NONCE}`;
    const r = parseResult(line, NONCE);
    assert.equal(r.stdout, "hé\u0000�");
    assert.equal(r.stdoutBytes, 5);
  });
});

describe("readiness and login matching", () => {
  test("only the executed probe counts as ready, not its echo", () => {
    assert.equal(isShellReady(`root@pve:~# ${probeLine(NONCE)}`, NONCE), false);
    assert.equal(isShellReady(`${probeLine(NONCE)}\r\nMCPRDY_${NONCE}\r\n`, NONCE), true);
    assert.equal(isShellReady(`MCPRDY_ffffffffffff\r\n`, NONCE), false);
  });

  test("login prompts match at the end of the transcript, case-insensitively", () => {
    assert.equal(matchLoginPrompt("\r\nproxmox-02 login: "), "username");
    assert.equal(matchLoginPrompt("PROXMOX-02 LOGIN:"), "username");
    assert.equal(matchLoginPrompt("alice\r\nPassword: "), "password");
    assert.equal(matchLoginPrompt("password:"), "password");
    assert.equal(matchLoginPrompt("Last login: Tue Nov 18 10:00:00 2026 from 10.0.0.2\r\n"), null);
    assert.equal(matchLoginPrompt("\r\nLogin incorrect\r\n\r\nproxmox-02 login: "), "username");
    assert.equal(matchLoginPrompt(""), null);
  });

  test("login output after the password is pending, incorrect, or ok", () => {
    assert.equal(classifyLoginOutput(""), "pending");
    assert.equal(classifyLoginOutput("\r\n"), "pending");
    assert.equal(classifyLoginOutput("\r\nLogin inc"), "pending");
    assert.equal(classifyLoginOutput("\r\nLogin incorrect\r\n"), "incorrect");
    assert.equal(classifyLoginOutput("\x1b[0m\r\nlogin Incorrect"), "incorrect");
    assert.equal(classifyLoginOutput("\r\nLinux pve 6.8.12\r\n"), "ok");
    assert.equal(classifyLoginOutput("\r\nLast login: Tue"), "ok");
  });
});

describe("wrapper", () => {
  test("types short lines that reassemble into the wrapper with no literal markers", () => {
    const command = "echo 'hi' \"$HOME\" !x";
    const typed = commandLine(command, NONCE, 30);
    for (const marker of ["MCPB", "MCPE", "MCPRDY"]) assert.ok(!typed.includes(marker));
    const wrapper = decodeWrapper(typed);
    assert.equal(wrapper, buildWrapper(command, NONCE, 30));
    for (const marker of [`MCPB_${NONCE}`, `MCPE_${NONCE}`, `MCPRDY_${NONCE}`]) {
      assert.ok(!wrapper.includes(marker), marker);
    }
    assert.ok(wrapper.includes(b64(command)));
    const lines = typed.split("\n");
    assert.equal(lines[0], "__in=$(mktemp /tmp/mcp-shell-in.XXXXXX)");
    assert.equal(lines.at(-2), 'eval "$(base64 -d "$__in"; rm -f "$__in")"');
    assert.equal(lines.at(-1), "");
  });

  for (const sudoPassword of [undefined, "s3cret pass"]) {
    test(`an 8192-byte multi-byte command is typed in lines of at most 1024 bytes ${sudoPassword ? "with" : "without"} sudo`, () => {
      const command = "é€x".repeat(1365) + "ab";
      assert.equal(Buffer.byteLength(command), 8192);
      assert.ok(command.length < 8192);
      const typed = commandLine(command, NONCE, 30, sudoPassword);
      assert.ok(typed.endsWith("\n"));
      const lines = typed.slice(0, -1).split("\n");
      const longest = Math.max(...lines.map((l) => Buffer.byteLength(l + "\n")));
      assert.ok(longest <= 1024, `longest line ${longest}`);
      const wrapper = buildWrapper(command, NONCE, 30, sudoPassword);
      assert.equal(lines.length, 2 + Math.ceil(b64(wrapper).length / 1000));
      assert.equal(decodeWrapper(typed), wrapper);
      for (const marker of [`MCPB_${NONCE}`, `MCPE_${NONCE}`, `MCPRDY_${NONCE}`]) {
        assert.ok(!typed.includes(marker), marker);
      }
    });
  }

  test("a root identity runs the command under timeout -k 5 with no sudo", () => {
    const wrapper = decodeWrapper(commandLine("true", NONCE, 42));
    assert.match(wrapper, /^timeout -k 5 42 bash "\$__d\/c" <\/dev\/null >"\$__d\/o" 2>"\$__d\/e"; __rc=\$\?$/m);
    assert.ok(!wrapper.includes("sudo"));
    assert.ok(wrapper.includes("rm -rf"));
    assert.ok(!/\bexit\b/.test(wrapper));
  });

  test("a sudo identity caches the credential with sudo -v then runs under sudo -n timeout", () => {
    const wrapper = decodeWrapper(commandLine("true", NONCE, 42, "s3cret pass"));
    const lines = wrapper.split("\n");
    const v = lines.findIndex((l) => l.includes("sudo -S -p '' -v"));
    const run = lines.findIndex((l) => l.startsWith("sudo -n timeout -k 5 42 bash"));
    assert.ok(v >= 0 && run === v + 1);
    assert.ok(lines[v].includes(b64("s3cret pass")));
    assert.ok(!wrapper.includes("s3cret pass"));
    assert.ok(!commandLine("true", NONCE, 42, "s3cret pass").includes("s3cret"));
  });

  test("refuses a timeout or nonce that could inject shell text", () => {
    assert.throws(() => buildWrapper("true", NONCE, 0));
    assert.throws(() => buildWrapper("true", NONCE, 1.5));
    assert.throws(() => buildWrapper("true", NONCE, Number.NaN));
    assert.throws(() => buildWrapper("true", "x; reboot", 5));
  });

  test("phase deadlines follow the plan", () => {
    assert.equal(phaseDeadlineMs("connecting", 60), 10_000);
    assert.equal(phaseDeadlineMs("authenticating", 60), 10_000);
    assert.equal(phaseDeadlineMs("logging_in", 60), 20_000);
    assert.equal(phaseDeadlineMs("awaiting_shell", 60), 20_000);
    assert.equal(phaseDeadlineMs("running", 60), 75_000);
  });
});

describe("wrapper run by a real bash", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-shell-shims-"));
  const gnuTools =
    spawnSync("sh", ["-c", "base64 -w0 </dev/null && stat -c %s / && command -v timeout"], { stdio: "ignore" }).status === 0;
  const shim = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  if (!gnuTools) {
    shim("base64", 'if [ "$1" = "-w0" ]; then shift; /usr/bin/base64 "$@" | tr -d "\\n"; elif [ "$1" = "-d" ] && [ -n "$2" ]; then exec /usr/bin/base64 -D -i "$2"; else exec /usr/bin/base64 "$@"; fi');
    shim("stat", 'if [ "$1" = "-c" ]; then exec /usr/bin/stat -f %z "$3"; fi; exec /usr/bin/stat "$@"');
    shim("timeout", "shift 3; exec \"$@\"");
  }

  const run = (command, sudoPassword) => {
    const r = spawnSync("bash", [], {
      input: commandLine(command, NONCE, 30, sudoPassword),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "latin1",
    });
    return { ...r, parsed: parseResult(r.stdout, NONCE) };
  };

  test("echo hello", () => {
    const r = run("echo hello");
    assert.deepEqual(r.parsed, { exitCode: 0, stdout: "hello\n", stderr: "", stdoutBytes: 6, stderrBytes: 0 });
    assert.equal(r.stdout.trimEnd().split("\n").length, 1, "the result is a single line");
  });

  test("separate stdout and stderr and a non-zero exit code", () => {
    const r = run("echo out; echo err >&2; exit 3");
    assert.equal(r.parsed.exitCode, 3);
    assert.equal(r.parsed.stdout, "out\n");
    assert.equal(r.parsed.stderr, "err\n");
  });

  test("quotes, variables, history characters and a heredoc survive", () => {
    const script = `x='a b'\ncat <<'EOF'\nline "$x" !bang \`not run\`\nEOF\necho "$x"`;
    const local = spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout;
    assert.equal(run(script).parsed.stdout, local);
  });

  test("multi-byte output and invalid bytes", () => {
    const r = run("printf 'h\\xc3\\xa9\\x00\\xff'");
    assert.equal(r.parsed.stdout, "hé\u0000�");
    assert.equal(r.parsed.stdoutBytes, 5);
  });

  test("output over the cap is truncated but its size is reported", () => {
    const r = run("seq 1 20000");
    assert.equal(r.parsed.stdoutBytes, 108894);
    assert.equal(Buffer.byteLength(r.parsed.stdout), OUTPUT_CAP_BYTES);
  });

  test("stdin is /dev/null and no temp directory is left behind", () => {
    const count = () =>
      Number(spawnSync("sh", ["-c", "ls -d /tmp/mcp-shell.* 2>/dev/null | wc -l"], { encoding: "utf8" }).stdout.trim());
    const before = count();
    const r = run("cat; echo done");
    assert.equal(r.parsed.stdout, "done\n");
    assert.equal(count(), before);
  });

  test("a multi-chunk command reassembles end to end and removes the typed-input file", () => {
    const countIn = () =>
      Number(spawnSync("sh", ["-c", "ls /tmp/mcp-shell-in.* 2>/dev/null | wc -l"], { encoding: "utf8" }).stdout.trim());
    const before = countIn();
    const text = "é€x".repeat(1500);
    const r = run(`echo '${text}' | wc -c`);
    assert.equal(r.parsed.exitCode, 0);
    assert.equal(r.parsed.stdout.trim(), String(Buffer.byteLength(text) + 1));
    assert.equal(countIn(), before);
  });

  test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  closedWith = [];
  terminated = 0;
  onSend = () => {};

  send(data, cb) {
    this.sent.push(data);
    cb?.();
    this.onSend(data);
  }
  close(code) {
    this.closedWith.push(code);
    this.readyState = 2;
  }
  terminate() {
    this.terminated++;
    this.readyState = 3;
  }
  reply(text) {
    setImmediate(() => this.emit("message", Buffer.from(text, "latin1"), true));
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function drive(promise, stepMs = 500, maxSteps = 400) {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await tick();
    mock.timers.tick(stepMs);
  }
  await tick();
  return promise;
}

const rootIdentity = { kind: "root", auth: { type: "password", username: "root@pam", password: "rootpw" } };
const linuxIdentity = (sudo = true) => ({
  kind: "linux",
  username: "alice",
  auth: { type: "password", username: "alice@pam", password: "alicepw" },
  sudo,
});
const ticket = { user: "root@pam", ticket: "PVE:root@pam:TICKET+/=", port: 5900, upid: "UPID:pve1:1:2:3:vncshell::root@pam:" };

function fakeNode(sock, options) {
  const behavior = createNodeBehavior(options);
  sock.onSend = (data) => behavior.handle(data, (text) => sock.reply(text));
  return behavior.state;
}


describe("runShellSession", () => {
  let sock;
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    sock = new FakeSocket();
  });
  afterEach(() => mock.timers.reset());

  const start = (identity, command = "echo hello", timeoutS = 60) => {
    const promise = runShellSession(sock, ticket, command, { node: "pve2", timeoutS, identity });
    sock.open();
    return promise;
  };

  test("a root session sends the raw ticket line, one command, and closes cleanly", async () => {
    fakeNode(sock, { identity: rootIdentity, execute: () => ({ rc: 0, out: "hello\n", err: "" }) });
    const r = await drive(start(rootIdentity));
    assert.deepEqual(r, { exitCode: 0, stdout: "hello\n", stderr: "", stdoutBytes: 6, stderrBytes: 0, upid: ticket.upid });
    assert.equal(sock.sent[0], `root@pam:${ticket.ticket}\n`);
    assert.equal(sock.sent.filter((f) => frameText(f).startsWith("__in=$(mktemp")).length, 1);
    assert.deepEqual(sock.closedWith, [1000]);
  });

  test("probes are resent until the shell answers and the command is still sent once", async () => {
    const state = fakeNode(sock, {
      identity: rootIdentity,
      ignoreProbes: 3,
      execute: () => ({ rc: 0, out: "ok", err: "" }),
    });
    await drive(start(rootIdentity));
    assert.ok(state.probes >= 4);
    assert.equal(state.commands, 1);
  });

  test("a finished session stops probing, pinging and force-terminating", async () => {
    fakeNode(sock, { identity: rootIdentity, execute: () => ({ rc: 0, out: "", err: "" }) });
    await drive(start(rootIdentity));
    sock.emit("close", 1000);
    const sentBefore = sock.sent.length;
    mock.timers.tick(120_000);
    assert.equal(sock.sent.length, sentBefore);
    assert.equal(sock.terminated, 0);
    assert.doesNotThrow(() => sock.emit("error", new Error("late")));
  });

  test("a socket that ignores close is terminated after 2 s", async () => {
    fakeNode(sock, { identity: rootIdentity, execute: () => ({ rc: 0, out: "", err: "" }) });
    await drive(start(rootIdentity));
    assert.equal(sock.terminated, 0);
    mock.timers.tick(2000);
    assert.equal(sock.terminated, 1);
  });

  test("a linux user answers login and Password, then runs the command through sudo", async () => {
    fakeNode(sock, { identity: linuxIdentity(), execute: () => ({ rc: 0, out: "root\n", err: "" }) });
    const r = await drive(start(linuxIdentity(), "id -un"));
    assert.equal(r.stdout, "root\n");
    const typed = sock.sent.map(frameText);
    assert.ok(typed.includes("alice\n"));
    assert.ok(typed.includes("alicepw\n"));
    assert.ok(typed.indexOf("alice\n") < typed.indexOf("alicepw\n"));
    const eval_ = typed.find((t) => t.startsWith("__in=$(mktemp"));
    assert.ok(decodeWrapper(eval_).includes("sudo -n timeout -k 5 60"));
    assert.ok(!eval_.includes("alicepw"));
  });

  test("a linux user with sudo off runs the command directly", async () => {
    fakeNode(sock, { identity: linuxIdentity(false), execute: () => ({ rc: 0, out: "alice\n", err: "" }) });
    await drive(start(linuxIdentity(false), "id -un"));
    const eval_ = sock.sent.map(frameText).find((t) => t.startsWith("__in=$(mktemp"));
    assert.ok(!decodeWrapper(eval_).includes("sudo"));
  });

  test("a wrong Linux password fails in logging_in after exactly one attempt and sends no command", async () => {
    const state = fakeNode(sock, { identity: linuxIdentity(), loginOk: false, execute: () => ({ rc: 0, out: "", err: "" }) });
    await assert.rejects(drive(start(linuxIdentity())), (e) => {
      assert.ok(e instanceof NodeShellError);
      assert.equal(e.phase, "logging_in");
      assert.match(e.message, /Login incorrect for Linux user alice on pve2/);
      assert.doesNotMatch(e.message, /alicepw/);
      return true;
    });
    assert.equal(state.passwordAttempts, 1);
    assert.equal(sock.sent.filter((f) => frameText(f).startsWith("__in=$(mktemp")).length, 0);
    assert.deepEqual(sock.closedWith, [1000]);
  });

  test("termproxy closing before OK names the authenticating phase", async () => {
    const p = start(rootIdentity);
    setImmediate(() => sock.emit("close", 1006));
    await assert.rejects(drive(p), (e) => e.phase === "authenticating" && /close code 1006/.test(e.message));
  });

  test("never opening the socket fails in connecting after 10 s and terminates it", async () => {
    const p = runShellSession(sock, ticket, "true", { node: "pve2", timeoutS: 60, identity: rootIdentity });
    mock.timers.tick(9_999);
    mock.timers.tick(1);
    await assert.rejects(p, (e) => e.phase === "connecting" && /10 s/.test(e.message));
    assert.equal(sock.terminated, 1);
  });

  test("a shell that never answers fails in awaiting_shell after 20 s", async () => {
    fakeNode(sock, { identity: rootIdentity, ignoreProbes: Infinity, execute: () => ({ rc: 0, out: "", err: "" }) });
    await assert.rejects(drive(start(rootIdentity)), (e) => e.phase === "awaiting_shell" && /20 s/.test(e.message));
  });

  test("no result fails in running after timeout_s + 15 s, pinging every 25 s, without leaking secrets", async () => {
    const pings = () => sock.sent.filter((f) => f === "2").length;
    fakeNode(sock, { identity: linuxIdentity(), execute: () => ({ rc: 0, out: "", err: "" }) });
    sock.onSend = ((inner) => (data) => {
      if (frameText(data).startsWith("__in=$(mktemp")) return;
      inner(data);
    })(sock.onSend);
    const settled = start(linuxIdentity(), "sleep 99", 60).then(
      () => null,
      (e) => e
    );
    for (let i = 0; i < 50 && !sock.sent.some((f) => frameText(f).startsWith("__in=$(mktemp")); i++) {
      await tick();
      mock.timers.tick(500);
    }
    mock.timers.tick(25_000);
    assert.equal(pings(), 1);
    mock.timers.tick(25_000);
    assert.equal(pings(), 2);
    mock.timers.tick(25_000);
    const e = await settled;
    assert.equal(e.phase, "running");
    assert.match(e.message, /75 s/);
    assert.doesNotMatch(e.message, /alicepw|TICKET/);
  });

  test("a websocket error rejects with the ticket redacted from the message", async () => {
    const p = start(rootIdentity);
    setImmediate(() => sock.emit("error", new Error(`failed for vncticket=${encodeURIComponent(ticket.ticket)}`)));
    await assert.rejects(drive(p), (e) => e.phase === "authenticating" && !e.message.includes("TICKET") && e.message.includes("***"));
  });

  test("a step that throws rejects and closes the socket instead of hanging", async () => {
    fakeNode(sock, { identity: rootIdentity, execute: () => ({ rc: 0, out: "", err: "" }) });
    await assert.rejects(drive(start(rootIdentity, "true", 0)), (e) => e instanceof NodeShellError && /Invalid timeout/.test(e.message));
    assert.deepEqual(sock.closedWith, [1000]);
  });
});
