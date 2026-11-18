import { randomBytes } from "node:crypto";
import type WebSocket from "ws";
import type { ShellIdentity } from "./config.js";

export interface TermProxyTicket {
  user: string;
  ticket: string;
  port: number;
  upid: string;
}

export interface ShellResult {
  exitCode: number; // 124 means the node-side timeout fired
  stdout: string;
  stderr: string;
  stdoutBytes: number; // size before truncation
  stderrBytes: number;
  upid: string;
}

export type ShellPhase = "connecting" | "authenticating" | "logging_in" | "awaiting_shell" | "running";

export class NodeShellError extends Error {
  constructor(
    readonly phase: ShellPhase,
    message: string
  ) {
    super(message);
    this.name = "NodeShellError";
  }
}

export const OUTPUT_CAP_BYTES = 32768;

const PROBE_INTERVAL_MS = 500;
const KEEPALIVE_MS = 25_000;
const CLOSE_GRACE_MS = 2_000;
const READY_MARKER = "MCPRDY";
const WS_CONNECTING = 0;
const WS_CLOSED = 3;

export function phaseDeadlineMs(phase: ShellPhase, timeoutS: number): number {
  switch (phase) {
    case "connecting":
    case "authenticating":
      return 10_000;
    case "logging_in":
    case "awaiting_shell":
      return 20_000;
    case "running":
      return (timeoutS + 15) * 1000;
  }
}

export function encodeInput(text: string): string {
  return `0:${Buffer.byteLength(text)}:${text}`;
}

export function probeLine(nonce: string): string {
  return `printf '%s_%s\\n' ${READY_MARKER} ${nonce}\n`;
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export function buildWrapper(command: string, nonce: string, timeoutS: number, sudoPassword?: string): string {
  if (!Number.isInteger(timeoutS) || timeoutS < 1) throw new Error(`Invalid timeout: ${timeoutS}`);
  if (!/^[0-9a-f]+$/.test(nonce)) throw new Error("Invalid nonce");
  const runCommand = `bash "$__d/c" </dev/null >"$__d/o" 2>"$__d/e"; __rc=$?`;
  const run =
    sudoPassword === undefined
      ? `timeout -k 5 ${timeoutS} ${runCommand}`
      : `{ printf %s '${b64(sudoPassword)}' | base64 -d; echo; } | sudo -S -p '' -v 2>/dev/null\n` +
        `sudo -n timeout -k 5 ${timeoutS} ${runCommand}`;
  return (
    [
      "mesg n 2>/dev/null; unset HISTFILE",
      `__d=$(mktemp -d /tmp/mcp-shell.XXXXXX)`,
      `printf %s '${b64(command)}' | base64 -d > "$__d/c"`,
      run,
      `printf '%s_%s:%s:%s:%s:' MCPB ${nonce} "$__rc" "$(stat -c %s "$__d/o")" "$(stat -c %s "$__d/e")"`,
      `head -c ${OUTPUT_CAP_BYTES} "$__d/o" | base64 -w0; printf ':'`,
      `head -c ${OUTPUT_CAP_BYTES} "$__d/e" | base64 -w0`,
      `rm -rf "$__d"`,
      `printf ':%s_%s\\n' MCPE ${nonce}`,
    ].join("\n") + "\n"
  );
}

export function commandLine(command: string, nonce: string, timeoutS: number, sudoPassword?: string): string {
  const wrapper = buildWrapper(command, nonce, timeoutS, sudoPassword);
  return `eval "$(printf %s '${b64(wrapper)}' | base64 -d)"\n`;
}

export interface ParsedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const decodeB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export function parseResult(transcript: string, nonce: string): ParsedResult | null {
  const n = escapeRegExp(nonce);
  const m = new RegExp(
    `MCPB_${n}:(\\d+):(\\d+):(\\d+):([A-Za-z0-9+/=]*):([A-Za-z0-9+/=]*):MCPE_${n}`
  ).exec(transcript);
  if (!m) return null;
  return {
    exitCode: Number(m[1]),
    stdoutBytes: Number(m[2]),
    stderrBytes: Number(m[3]),
    stdout: decodeB64(m[4]),
    stderr: decodeB64(m[5]),
  };
}

export function isShellReady(transcript: string, nonce: string): boolean {
  return transcript.includes(`${READY_MARKER}_${nonce}`);
}

export function matchLoginPrompt(transcript: string): "username" | "password" | null {
  if (/login:\s*$/i.test(transcript)) return "username";
  if (/password:\s*$/i.test(transcript)) return "password";
  return null;
}

export type LoginOutcome = "pending" | "incorrect" | "ok";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function classifyLoginOutput(afterPassword: string): LoginOutcome {
  const text = afterPassword.replace(ANSI, "").trim().toLowerCase();
  if (text === "") return "pending";
  if (text.includes("login incorrect")) return "incorrect";
  return "login incorrect".startsWith(text) ? "pending" : "ok";
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((s) => s !== "")
    .flatMap((s) => [s, encodeURIComponent(s)])
    .reduce((acc, s) => acc.split(s).join("***"), text);
}

function lastOutput(transcript: string, secrets: readonly string[]): string {
  const tail = redact(transcript, secrets)
    .replace(ANSI, "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(-200);
  return tail === "" ? "" : ` Last output: "${tail}".`;
}

export function rawToLatin1(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("latin1");
  if (Array.isArray(data)) return Buffer.concat(data).toString("latin1");
  return Buffer.from(data).toString("latin1");
}

type LoginStep = "username" | "password" | "verifying";

interface FailureContext {
  node: string;
  timeoutS: number;
  identity: ShellIdentity;
  port: number;
  loginStep: LoginStep;
  tail: string;
  closeCode?: number;
}

const closeInfo = (c: FailureContext) => `(close code ${c.closeCode ?? "unknown"})`;

const PHASE_FAILURES: Record<
  ShellPhase,
  { timeout: (c: FailureContext) => string; closed: (c: FailureContext) => string }
> = {
  connecting: {
    timeout: (c) =>
      `Timed out after 10 s opening the terminal WebSocket (termproxy port ${c.port}). termproxy only waits 10 s ` +
      `after the ticket request. Check that pveproxy on the API host is reachable.`,
    closed: (c) => `The terminal WebSocket closed before it opened ${closeInfo(c)}.`,
  },
  authenticating: {
    timeout: () => "termproxy did not reply to the ticket within 10 s.",
    closed: (c) =>
      `termproxy closed the connection before replying OK ${closeInfo(c)}. It rejected the ticket or could not ` +
      `start the shell on this node.`,
  },
  logging_in: {
    timeout: (c) =>
      `The login on ${c.node} did not finish within 20 s (stuck at the ${c.loginStep} step). The Linux account ` +
      `must exist on that node.${c.tail}`,
    closed: (c) => `The terminal closed during the Linux login on ${c.node} ${closeInfo(c)}.${c.tail}`,
  },
  awaiting_shell: {
    timeout: (c) =>
      `No shell answered on ${c.node} within 20 s. If root's or the user's shell profile starts tmux, screen, or ` +
      `a prompt, that blocks it. Remote nodes add an SSH hop that must also succeed.${c.tail}`,
    closed: (c) =>
      `The terminal closed on ${c.node} before a shell answered ${closeInfo(c)}. The login shell may have exited.${c.tail}`,
  },
  running: {
    timeout: (c) =>
      `No result within ${c.timeoutS + 15} s. The command may still be running on ${c.node}; its node-side ` +
      `timeout kills it after at most ${c.timeoutS + 5} s.`,
    closed: (c) =>
      `The terminal closed before the command finished ${closeInfo(c)}. The command may still be running on ` +
      `${c.node} until its timeout fires.`,
  },
};

function closeSocket(ws: ShellSocket): void {
  if (ws.readyState === WS_CLOSED) return;
  if (ws.readyState === WS_CONNECTING) {
    ws.terminate();
    return;
  }
  ws.close(1000);
  const force = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
  force.unref();
  ws.on("close", () => clearTimeout(force));
}

export type ShellSocket = Pick<WebSocket, "send" | "close" | "terminate" | "on" | "readyState">;

export interface RunOptions {
  node: string;
  timeoutS: number;
  identity: ShellIdentity;
}

export function runShellSession(
  ws: ShellSocket,
  ticket: TermProxyTicket,
  command: string,
  opts: RunOptions
): Promise<ShellResult> {
  const { node, timeoutS, identity } = opts;
  const secrets = [ticket.ticket, identity.auth.password];
  const nonce = randomBytes(6).toString("hex");

  return new Promise<ShellResult>((resolve, reject) => {
    let phase: ShellPhase = "connecting";
    let loginStep: LoginStep = "username";
    let transcript = "";
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(ticker);
      try {
        closeSocket(ws);
      } finally {
        settle();
      }
    };

    const fail = (message: string) => {
      const failedIn = phase;
      finish(() => reject(new NodeShellError(failedIn, redact(message, [ticket.ticket]))));
    };

    const failure = (kind: "timeout" | "closed", closeCode?: number) =>
      PHASE_FAILURES[phase][kind]({
        node,
        timeoutS,
        identity,
        port: ticket.port,
        loginStep,
        tail: lastOutput(transcript, secrets),
        closeCode,
      });

    const sendRaw = (data: string) =>
      ws.send(data, (err) => {
        if (err) fail(`Could not write to the terminal: ${err.message}`);
      });
    const sendInput = (text: string) => sendRaw(encodeInput(text));

    const guarded =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (settled) return;
        try {
          fn(...args);
        } catch (e) {
          fail(`Internal error: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

    const sudoPassword = identity.kind === "linux" && identity.sudo ? identity.auth.password : undefined;

    const enter = (next: ShellPhase) => {
      phase = next;
      clearTimeout(deadline);
      clearInterval(ticker);
      ticker = undefined;
      deadline = setTimeout(
        guarded(() => fail(failure("timeout"))),
        phaseDeadlineMs(next, timeoutS)
      );
      if (next === "awaiting_shell") {
        const probe = () => sendInput(probeLine(nonce));
        probe();
        ticker = setInterval(guarded(probe), PROBE_INTERVAL_MS);
      } else if (next === "running") {
        ticker = setInterval(guarded(() => sendRaw("2")), KEEPALIVE_MS);
      }
    };

    const advance = () => {
      switch (phase) {
        case "connecting":
          return;
        case "authenticating":
          if (transcript.length < 2) return;
          if (!transcript.startsWith("OK")) {
            fail("termproxy replied with something other than OK.");
            return;
          }
          transcript = transcript.slice(2);
          enter(identity.kind === "linux" ? "logging_in" : "awaiting_shell");
          advance();
          return;
        case "logging_in": {
          if (identity.kind !== "linux") return;
          if (loginStep === "username" && matchLoginPrompt(transcript) === "username") {
            sendInput(`${identity.username}\n`);
            transcript = "";
            loginStep = "password";
          } else if (loginStep === "password" && matchLoginPrompt(transcript) === "password") {
            sendInput(`${identity.auth.password}\n`);
            transcript = "";
            loginStep = "verifying";
          } else if (loginStep === "verifying") {
            const outcome = classifyLoginOutput(transcript);
            if (outcome === "incorrect") {
              fail(
                `Login incorrect for Linux user ${identity.username} on ${node}. The account must exist on that ` +
                  `node with the password from shell.password. Not retried.`
              );
            } else if (outcome === "ok") {
              enter("awaiting_shell");
              advance();
            }
          }
          return;
        }
        case "awaiting_shell":
          if (!isShellReady(transcript, nonce)) return;
          transcript = "";
          sendInput(commandLine(command, nonce, timeoutS, sudoPassword));
          enter("running");
          return;
        case "running": {
          const result = parseResult(transcript, nonce);
          if (result) finish(() => resolve({ ...result, upid: ticket.upid }));
          return;
        }
      }
    };

    ws.on(
      "error",
      guarded((err: Error) => fail(`Terminal connection failed: ${err.message}.`))
    );
    ws.on(
      "open",
      guarded(() => {
        sendRaw(`${ticket.user}:${ticket.ticket}\n`);
        enter("authenticating");
      })
    );
    ws.on(
      "message",
      guarded((data: WebSocket.RawData) => {
        transcript += rawToLatin1(data);
        advance();
      })
    );
    ws.on(
      "close",
      guarded((code: number) => fail(failure("closed", code)))
    );

    enter("connecting");
  });
}
