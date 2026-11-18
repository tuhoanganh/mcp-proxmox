import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".mcp-proxmox");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export type AuthConfig =
  | { type: "apitoken"; token: string }
  | { type: "password"; username: string; password: string; totp?: string };

export type PasswordAuth = Extract<AuthConfig, { type: "password" }>;

export interface ShellConfig {
  user?: string;
  password?: string;
  totp?: string;
  sudo?: boolean;
}

export interface ProxmoxConfig {
  host: string;
  port: number;
  auth: AuthConfig;
  insecure?: boolean; // skip TLS verify (default true for self-signed)
  shell?: ShellConfig;
}

// PVE 8 rejects API tokens for termproxy, so a shell identity always opens it with its own password ticket.
export type ShellIdentity =
  | { kind: "root"; auth: PasswordAuth }
  | { kind: "linux"; username: string; auth: PasswordAuth; sudo: boolean };

export type ShellIdentityResult =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "enabled"; identity: ShellIdentity };

const LINUX_USERNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

const invalid = (reason: string): ShellIdentityResult => ({ status: "invalid", reason });

export function parseShellIdentity(config: ProxmoxConfig): ShellIdentityResult {
  const block = config.shell;
  if (block == null) {
    const { auth } = config;
    return auth.type === "password" && auth.username === "root@pam"
      ? { status: "enabled", identity: { kind: "root", auth } }
      : { status: "absent" };
  }
  if (typeof block !== "object" || Array.isArray(block)) {
    return invalid('"shell" must be an object like {"user":"alice","password":"...","sudo":true}.');
  }

  const { user, password, totp, sudo } = block;
  if (user != null && (typeof user !== "string" || user === "")) {
    return invalid('shell.user must be a non-empty string. Set it to "root@pam" or a Linux username.');
  }
  if (typeof password !== "string" || password === "") {
    return invalid("shell.password is missing or empty. Set it to the shell user's password.");
  }
  if (totp != null && typeof totp !== "string") {
    return invalid("shell.totp must be a base32 string. Remove it if the shell user has no 2FA.");
  }
  if (sudo != null && typeof sudo !== "boolean") {
    return invalid("shell.sudo must be true or false.");
  }

  const at = user == null ? -1 : user.lastIndexOf("@");
  const name = user == null ? "root" : at < 0 ? user : user.slice(0, at);
  const realm = user == null || at < 0 ? "pam" : user.slice(at + 1);
  if (realm !== "pam") {
    return invalid(
      `shell.user "${user}" is in realm "${realm}". The terminal login checks Linux accounts, so only PAM users work. ` +
        `Set shell.user to the Linux username, such as "alice" or "alice@pam".`
    );
  }
  if (name !== "root" && !LINUX_USERNAME.test(name)) {
    return invalid(
      `shell.user "${user}" is not a valid Linux username. Use letters, digits, "_", "-" and ".", starting with a letter or "_".`
    );
  }

  const auth: PasswordAuth = {
    type: "password",
    username: `${name}@pam`,
    password,
    ...(totp ? { totp } : {}),
  };
  return {
    status: "enabled",
    identity: name === "root" ? { kind: "root", auth } : { kind: "linux", username: name, auth, sudo: sudo ?? true },
  };
}

export const SETUP_GUIDE = `No Proxmox config found at ${CONFIG_FILE}.
Configure it with any one of:

  1. In Claude Code, ask Claude to "set up proxmox" (uses the setup_proxmox tool).
  2. Run the wizard: npx -y -p mcp-proxmox mcp-proxmox-setup
  3. Create ${CONFIG_FILE} by hand, then run: chmod 600 ${CONFIG_FILE}

     API token:
     {"host":"<proxmox_ip>","port":8006,"auth":{"type":"apitoken","token":"<username>@pam!<token_id>=<token_secret>"},"insecure":true}

     Password:
     {"host":"<proxmox_ip>","port":8006,"auth":{"type":"password","username":"<username>@pam","password":"<password>"},"insecure":true}
     (add "totp":"<base32 secret>" inside "auth" to enable 2FA)

Then restart Claude Code.`;

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): ProxmoxConfig {
  if (!configExists()) throw new Error(SETUP_GUIDE);
  const raw = readFileSync(CONFIG_FILE, "utf8");
  return JSON.parse(raw) as ProxmoxConfig;
}

export function saveConfig(cfg: ProxmoxConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
