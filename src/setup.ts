#!/usr/bin/env node
/**
 * Interactive setup CLI for mcp-proxmox.
 * Run: node dist/setup.js
 */
import * as readline from "node:readline";
import { saveConfig, CONFIG_FILE, type ProxmoxConfig } from "./config.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    let input = "";
    const handler = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\r" || c === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "") {
        input = input.slice(0, -1);
      } else {
        input += c;
      }
    };
    process.stdin.resume();
    process.stdin.on("data", handler);
  });
}

async function main() {
  console.log("\n=== Proxmox MCP Setup ===\n");

  const host = await ask("Proxmox host/IP (e.g. 192.168.1.100): ");
  const portStr = await ask("Port [8006]: ");
  const port = portStr ? parseInt(portStr, 10) : 8006;

  console.log("\nAuth type:");
  console.log("  1) API token (recommended)");
  console.log("  2) Username + password");
  console.log("  3) Username + password + TOTP");
  const authChoice = await ask("Choice [1]: ");

  let auth: ProxmoxConfig["auth"];

  if (!authChoice || authChoice === "1") {
    console.log('\nAPI token format: user@realm!tokenid=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    const token = await ask("API token: ");
    auth = { type: "apitoken", token };
  } else if (authChoice === "2") {
    const username = await ask("Username (e.g. root@pam): ");
    const password = await askSecret("Password: ");
    auth = { type: "password", username, password };
  } else {
    const username = await ask("Username (e.g. user@pam): ");
    const password = await askSecret("Password: ");
    console.log("\nTOTP base32 secret (from your authenticator app setup, e.g. JBSWY3DPEHPK3PXP):");
    const totp = await ask("TOTP secret: ");
    auth = { type: "password", username, password, totp };
  }

  const insecureStr = await ask("\nSkip TLS certificate verification? (y/N) [y]: ");
  const insecure = !insecureStr || insecureStr.toLowerCase() !== "n";

  const config: ProxmoxConfig = { host, port, auth, insecure };
  saveConfig(config);

  console.log(`\n✓ Config saved to: ${CONFIG_FILE}`);
  console.log("  Run 'node dist/server.js' to start the MCP server.\n");

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
