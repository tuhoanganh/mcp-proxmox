import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".mcp-proxmox");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export type AuthConfig =
  | { type: "apitoken"; token: string }
  | { type: "password"; username: string; password: string; totp?: string };

export interface ProxmoxConfig {
  host: string;
  port: number;
  auth: AuthConfig;
  insecure?: boolean; // skip TLS verify (default true for self-signed)
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
