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
  expiresAt: number;
}

// PVE tickets last 2 h. Renew early so a request never carries one that expires in flight.
const TICKET_LIFETIME_MS = 100 * 60 * 1000;

export async function createSession(
  baseUrl: string,
  auth: AuthConfig,
  insecure = true
): Promise<Session> {
  const agent = new https.Agent({ rejectUnauthorized: !insecure });

  if (auth.type === "apitoken") {
    return { tokenHeader: `PVEAPIToken=${auth.token}`, expiresAt: Infinity };
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
    return {
      ticket: data1.ticket,
      csrf: data1.CSRFPreventionToken,
      expiresAt: Date.now() + TICKET_LIFETIME_MS,
    };
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
  return {
    ticket: data2.ticket,
    csrf: data2.CSRFPreventionToken,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
  };
}

export class SessionCache {
  private session: Session | null = null;
  private pending: Promise<Session> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthConfig,
    private readonly insecure: boolean
  ) {}

  async ensure(): Promise<Session> {
    if (this.session && Date.now() < this.session.expiresAt) return this.session;
    this.pending ??= createSession(this.baseUrl, this.auth, this.insecure)
      .then((s) => (this.session = s))
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  current(): Session {
    if (!this.session) throw new Error("Not authenticated");
    return this.session;
  }
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
