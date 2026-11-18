import axios, { AxiosError } from "axios";
import { authenticator } from "otplib";
import https from "node:https";
import type { AuthConfig } from "./config.js";

export class TotpRequiredError extends Error {
  constructor() {
    super(
      "Proxmox requires TOTP but no totp secret is configured. " +
        "Run npx -y -p mcp-proxmox mcp-proxmox-setup to add your TOTP secret."
    );
    this.name = "TotpRequiredError";
  }
}

export class TotpPromptCancelledError extends Error {
  constructor() {
    super("The TOTP prompt was cancelled or the code was not 6 digits.");
    this.name = "TotpPromptCancelledError";
  }
}

/** Resolves to the current 6-digit code for `username`, or rejects with TotpPromptCancelledError. */
export type AskTotpCode = (username: string) => Promise<string>;

const codeSentErrors = new WeakSet<object>();

export function failedAfterCodeSent(e: unknown): boolean {
  return typeof e === "object" && e !== null && codeSentErrors.has(e);
}

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

async function totpCode(auth: { username: string; totp?: string }, askTotpCode?: AskTotpCode): Promise<string> {
  if (auth.totp) return authenticator.generate(auth.totp);
  if (askTotpCode) return askTotpCode(auth.username);
  throw new TotpRequiredError();
}

async function postTicket(url: string, form: URLSearchParams, agent: https.Agent, codeSent = false) {
  try {
    return await axios.post(url, form, {
      httpsAgent: agent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    if (codeSent && e instanceof AxiosError) codeSentErrors.add(e);
    throw e;
  }
}

export async function createSession(
  baseUrl: string,
  auth: AuthConfig,
  insecure = true,
  askTotpCode?: AskTotpCode
): Promise<Session> {
  const agent = new https.Agent({ rejectUnauthorized: !insecure });

  if (auth.type === "apitoken") {
    return { tokenHeader: `PVEAPIToken=${auth.token}`, expiresAt: Infinity };
  }

  // Step 1: initial ticket request
  const resp1 = await postTicket(
    `${baseUrl}/access/ticket`,
    new URLSearchParams({ username: auth.username, password: auth.password }),
    agent
  );

  const data1 = resp1.data?.data;

  if (data1?.NeedTFA) {
    const code = await totpCode(auth, askTotpCode);
    const resp = await postTicket(
      `${baseUrl}/access/ticket`,
      new URLSearchParams({
        username: auth.username,
        "tfa-challenge": data1.ticket,
        password: `totp:${code}`,
      }),
      agent,
      true
    );
    const data = resp.data?.data;
    return {
      ticket: data.ticket,
      csrf: data.CSRFPreventionToken,
      expiresAt: Date.now() + TICKET_LIFETIME_MS,
    };
  }

  // If no TFA required, we have the real ticket
  if (!data1?.ticket?.startsWith("PVECHALLENGE:")) {
    return {
      ticket: data1.ticket,
      csrf: data1.CSRFPreventionToken,
      expiresAt: Date.now() + TICKET_LIFETIME_MS,
    };
  }

  // Step 2: TFA challenge — generate TOTP
  const code = await totpCode(auth, askTotpCode);

  const resp2 = await postTicket(
    `${baseUrl}/access/ticket`,
    new URLSearchParams({
      username: auth.username,
      password: data1.ticket, // the PVECHALLENGE token
      totp: code,
    }),
    agent,
    true
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

  async ensure(askTotpCode?: AskTotpCode): Promise<Session> {
    if (this.session && Date.now() < this.session.expiresAt) return this.session;
    this.pending ??= createSession(this.baseUrl, this.auth, this.insecure, askTotpCode)
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
