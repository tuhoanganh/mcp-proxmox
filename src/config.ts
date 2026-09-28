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

export function loadConfig(): ProxmoxConfig {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `No Proxmox config found. Run: node dist/setup.js\n` +
        `(Config location: ${CONFIG_FILE})`
    );
  }
  const raw = readFileSync(CONFIG_FILE, "utf8");
  return JSON.parse(raw) as ProxmoxConfig;
}

export function saveConfig(cfg: ProxmoxConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
