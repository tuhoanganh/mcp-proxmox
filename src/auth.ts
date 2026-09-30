import axios from "axios";
import { authenticator } from "otplib";
import https from "node:https";
import type { AuthConfig } from "./config.js";

export interface Session {
  /** For password auth: PVEAuthCookie value */
  ticket?: string;
  /** For password auth: CSRF token */
  csrf?: string;
  /** For token auth: full Authorization header value */
  tokenHeader?: string;
}

export async function createSession(
  baseUrl: string,
  auth: AuthConfig,
  insecure = true
): Promise<Session> {
  const agent = new https.Agent({ rejectUnauthorized: !insecure });

  if (auth.type === "apitoken") {
    return { tokenHeader: `PVEAPIToken=${auth.token}` };
  }

  // Step 1: initial ticket request
  const resp1 = await axios.post(
    `${baseUrl}/access/ticket`,
    new URLSearchParams({ username: auth.username, password: auth.password }),
    { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const data1 = resp1.data?.data;

  // If no TFA required, we have the real ticket
  if (!data1?.ticket?.startsWith("PVECHALLENGE:")) {
    return { ticket: data1.ticket, csrf: data1.CSRFPreventionToken };
  }

  // Step 2: TFA challenge — generate TOTP
  if (!auth.totp) {
    throw new Error(
      "Proxmox requires TOTP but no totp secret is configured. " +
        "Run npx -y -p mcp-proxmox mcp-proxmox-setup to add your TOTP secret."
    );
  }
  const code = authenticator.generate(auth.totp);

  const resp2 = await axios.post(
    `${baseUrl}/access/ticket`,
    new URLSearchParams({
      username: auth.username,
      password: data1.ticket, // the PVECHALLENGE token
      totp: code,
    }),
    { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const data2 = resp2.data?.data;
  return { ticket: data2.ticket, csrf: data2.CSRFPreventionToken };
}

export function sessionHeaders(session: Session): Record<string, string> {
  if (session.tokenHeader) {
    return { Authorization: session.tokenHeader };
  }
  return {
    Cookie: `PVEAuthCookie=${session.ticket}`,
    CSRFPreventionToken: session.csrf!,
  };
}
