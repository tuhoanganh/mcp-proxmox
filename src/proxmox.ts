import axios, { AxiosInstance, AxiosError } from "axios";
import https from "node:https";
import type { ProxmoxConfig } from "./config.js";
import { createSession, sessionHeaders, type Session } from "./auth.js";

export interface VMInfo {
  vmid: number;
  name: string;
  node: string;
  type: "qemu" | "lxc";
  status: "running" | "stopped" | "paused" | "suspended";
  cpus: number;
  maxmem: number;
  maxdisk: number;
  uptime: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  netin?: number;
  netout?: number;
}

export interface NodeStatus {
  node: string;
  status: "online" | "offline" | "unknown";
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

export interface Snapshot {
  name: string;
  description: string;
  snaptime: number;
  parent?: string;
  vmstate?: boolean;
}

export interface Task {
  upid: string;
  type: string;
  status: string;
  user: string;
  starttime: number;
  endtime?: number;
  node: string;
}

export interface GuestExecStatus {
  exited: number;
  exitcode?: number;
  signal?: number;
  "out-data"?: string;
  "err-data"?: string;
  truncated?: boolean;
}

export interface TaskStatus {
  status: "running" | "stopped";
  exitstatus?: string;
}

export interface Pool {
  poolid: string;
  comment?: string;
}

export interface PoolDetail {
  poolid: string;
  comment?: string;
  members: PoolMember[];
}

export interface PoolMember {
  id: string;
  node: string;
  vmid?: number;
  type: "qemu" | "lxc" | "storage";
  name?: string;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  maxcpu?: number;
  disk?: number;
  maxdisk?: number;
}

export interface VMConfig {
  name?: string;
  cores?: number;
  sockets?: number;
  memory?: number;
  cpu?: string;
  ostype?: string;
  bootdisk?: string;
  onboot?: number;
  description?: string;
  tags?: string;
  agent?: string;
  balloon?: number;
  bios?: string;
  boot?: string;
  [key: string]: unknown;
}

export interface VMStatusDetail {
  status: string;
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  netin: number;
  netout: number;
  uptime: number;
  name?: string;
  qmpstatus?: string;
  pid?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProxmoxClient {
  private http: AxiosInstance;
  private session: Session | null = null;
  private baseUrl: string;
  private config: ProxmoxConfig;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    this.baseUrl = `https://${config.host}:${config.port}/api2/json`;
    const agent = new https.Agent({ rejectUnauthorized: !(config.insecure ?? true) });
    this.http = axios.create({ baseURL: this.baseUrl, httpsAgent: agent });
  }

  async ensureSession(): Promise<void> {
    if (this.session) return;
    this.session = await createSession(this.baseUrl, this.config.auth, this.config.insecure ?? true);
  }

  private headers(): Record<string, string> {
    if (!this.session) throw new Error("Not authenticated");
    return sessionHeaders(this.session);
  }

  private handleError(err: unknown): never {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const msg = err.response?.data?.errors
        ? JSON.stringify(err.response.data.errors)
        : err.response?.data?.message ?? err.message;

      if (status === 401) throw new Error("Authentication failed — session may have expired.");
      if (status === 403) throw new Error(`Permission denied: ${msg}`);
      if (status === 500) throw new Error(`Proxmox server error: ${msg}`);
      if (err.code === "ECONNREFUSED")
        throw new Error(`Cannot connect to Proxmox at ${this.config.host}:${this.config.port}`);
      throw new Error(`Proxmox API error (${status}): ${msg}`);
    }
    throw err;
  }

  async listNodes(): Promise<NodeStatus[]> {
    await this.ensureSession();
    try {
      const r = await this.http.get("/nodes", { headers: this.headers() });
      return r.data.data as NodeStatus[];
    } catch (e) {
      this.handleError(e);
    }
  }

  async listVMs(node?: string): Promise<VMInfo[]> {
    await this.ensureSession();
    try {
      const nodes = node ? [{ node }] : await this.listNodes();
      const results: VMInfo[] = [];
      for (const n of nodes) {
        const [qemu, lxc] = await Promise.all([
          this.http
            .get(`/nodes/${n.node}/qemu`, { headers: this.headers() })
            .then((r) => r.data.data.map((v: VMInfo) => ({ ...v, node: n.node, type: "qemu" })))
            .catch(() => []),
          this.http
            .get(`/nodes/${n.node}/lxc`, { headers: this.headers() })
            .then((r) => r.data.data.map((v: VMInfo) => ({ ...v, node: n.node, type: "lxc" })))
            .catch(() => []),
        ]);
        results.push(...qemu, ...lxc);
      }
      return results.sort((a, b) => a.vmid - b.vmid);
    } catch (e) {
      this.handleError(e);
    }
  }

  async vmAction(
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    action: "start" | "stop" | "reboot" | "shutdown" | "reset" | "suspend" | "resume"
  ): Promise<string> {
    await this.ensureSession();
    const path = `nodes/${node}/${type}/${vmid}/status/${action}`;
    try {
      const r = await this.http.post(`/${path}`, {}, { headers: this.headers() });
      return r.data.data as string; // UPID
    } catch (e) {
      this.handleError(e);
    }
  }

  async deleteVM(node: string, vmid: number, type: "qemu" | "lxc"): Promise<string> {
    await this.ensureSession();
    try {
      const r = await this.http.delete(`/nodes/${node}/${type}/${vmid}`, {
        headers: this.headers(),
      });
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async listSnapshots(node: string, vmid: number, type: "qemu" | "lxc"): Promise<Snapshot[]> {
    await this.ensureSession();
    try {
      const r = await this.http.get(`/nodes/${node}/${type}/${vmid}/snapshot`, {
        headers: this.headers(),
      });
      return r.data.data as Snapshot[];
    } catch (e) {
      this.handleError(e);
    }
  }

  async createSnapshot(
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    name: string,
    description?: string,
    vmstate?: boolean
  ): Promise<string> {
    await this.ensureSession();
    try {
      const body: Record<string, unknown> = { snapname: name };
      if (description) body.description = description;
      if (type === "qemu" && vmstate !== undefined) body.vmstate = vmstate ? 1 : 0;
      const r = await this.http.post(`/nodes/${node}/${type}/${vmid}/snapshot`, body, {
        headers: this.headers(),
      });
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async rollbackSnapshot(
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    snapname: string
  ): Promise<string> {
    await this.ensureSession();
    try {
      const r = await this.http.post(
        `/nodes/${node}/${type}/${vmid}/snapshot/${snapname}/rollback`,
        {},
        { headers: this.headers() }
      );
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async deleteSnapshot(
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    snapname: string
  ): Promise<string> {
    await this.ensureSession();
    try {
      const r = await this.http.delete(
        `/nodes/${node}/${type}/${vmid}/snapshot/${snapname}`,
        { headers: this.headers() }
      );
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async getNodeTasks(node: string, limit = 50): Promise<Task[]> {
    await this.ensureSession();
    try {
      const r = await this.http.get(`/nodes/${node}/tasks`, {
        params: { limit },
        headers: this.headers(),
      });
      return r.data.data as Task[];
    } catch (e) {
      this.handleError(e);
    }
  }

  async createApiToken(
    userid: string,
    tokenid: string,
    expire?: number,
    privsep?: boolean
  ): Promise<{ value: string; full: string }> {
    await this.ensureSession();
    try {
      const body: Record<string, unknown> = {};
      if (expire !== undefined) body.expire = expire;
      if (privsep !== undefined) body.privsep = privsep ? 1 : 0;
      const r = await this.http.post(`/access/users/${userid}/token/${tokenid}`, body, {
        headers: this.headers(),
      });
      const d = r.data.data;
      return {
        value: d.value,
        full: `${userid}!${tokenid}=${d.value}`,
      };
    } catch (e) {
      this.handleError(e);
    }
  }

  async getVersion(): Promise<{ version: string; release: string }> {
    await this.ensureSession();
    try {
      const r = await this.http.get("/version", { headers: this.headers() });
      return r.data.data;
    } catch (e) {
      this.handleError(e);
    }
  }

  async getCurrentUser(): Promise<string> {
    // Extract user from session
    if (this.config.auth.type === "password") return this.config.auth.username;
    // From token: "user@realm!tokenid=..." → "user@realm"
    const token = this.config.auth.token;
    return token.split("!")[0];
  }

  async listPools(): Promise<Pool[]> {
    await this.ensureSession();
    try {
      const r = await this.http.get("/pools", { headers: this.headers() });
      return r.data.data as Pool[];
    } catch (e) {
      this.handleError(e);
    }
  }

  async getPool(poolid: string): Promise<PoolDetail> {
    await this.ensureSession();
    try {
      const r = await this.http.get(`/pools/${encodeURIComponent(poolid)}`, {
        headers: this.headers(),
      });
      return r.data.data as PoolDetail;
    } catch (e) {
      this.handleError(e);
    }
  }

  async getVMConfig(node: string, vmid: number, type: "qemu" | "lxc"): Promise<VMConfig> {
    await this.ensureSession();
    try {
      const r = await this.http.get(`/nodes/${node}/${type}/${vmid}/config`, {
        headers: this.headers(),
      });
      return r.data.data as VMConfig;
    } catch (e) {
      this.handleError(e);
    }
  }

  async getVMStatusDetail(node: string, vmid: number, type: "qemu" | "lxc"): Promise<VMStatusDetail> {
    await this.ensureSession();
    try {
      const r = await this.http.get(`/nodes/${node}/${type}/${vmid}/status/current`, {
        headers: this.headers(),
      });
      return r.data.data as VMStatusDetail;
    } catch (e) {
      this.handleError(e);
    }
  }

  async migrateVM(
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    target: string,
    online = false,
    withLocalDisks = false
  ): Promise<string> {
    await this.ensureSession();
    try {
      const body: Record<string, unknown> = { target };
      if (type === "qemu") {
        if (online) body.online = 1;
        if (withLocalDisks) body["with-local-disks"] = 1;
      }
      const r = await this.http.post(
        `/nodes/${node}/${type}/${vmid}/migrate`,
        body,
        { headers: this.headers() }
      );
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async cloneVM(
    node: string,
    vmid: number,
    newid: number,
    opts: { name?: string; target?: string; storage?: string; pool?: string } = {}
  ): Promise<string> {
    await this.ensureSession();
    try {
      const body: Record<string, unknown> = { newid, full: 1 };
      if (opts.name) body.name = opts.name;
      if (opts.target) body.target = opts.target;
      if (opts.storage) body.storage = opts.storage;
      if (opts.pool) body.pool = opts.pool;
      const r = await this.http.post(
        `/nodes/${node}/qemu/${vmid}/clone`,
        body,
        { headers: this.headers() }
      );
      return r.data.data as string;
    } catch (e) {
      this.handleError(e);
    }
  }

  async updateVMConfig(
    node: string,
    vmid: number,
    params: Record<string, string | number>
  ): Promise<void> {
    await this.ensureSession();
    try {
      await this.http.put(
        `/nodes/${node}/qemu/${vmid}/config`,
        params,
        { headers: this.headers() }
      );
    } catch (e) {
      this.handleError(e);
    }
  }

  async addVmsToPool(poolid: string, vmids: number[]): Promise<void> {
    await this.ensureSession();
    try {
      await this.http.put(
        `/pools/${encodeURIComponent(poolid)}`,
        { vms: vmids.join(",") },
        { headers: this.headers() }
      );
    } catch (e) {
      this.handleError(e);
    }
  }

  async getNextId(): Promise<number> {
    await this.ensureSession();
    try {
      const r = await this.http.get("/cluster/nextid", { headers: this.headers() });
      return Number(r.data.data);
    } catch (e) {
      this.handleError(e);
    }
  }

  async guestFileWrite(node: string, vmid: number, file: string, content: string): Promise<void> {
    await this.ensureSession();
    try {
      await this.http.post(
        `/nodes/${node}/qemu/${vmid}/agent/file-write`,
        { file, content },
        { headers: this.headers() }
      );
    } catch (e) {
      this.handleError(e);
    }
  }

  async guestExec(node: string, vmid: number, command: string | string[]): Promise<number> {
    await this.ensureSession();
    const cmd = Array.isArray(command) ? command : ["/bin/sh", "-c", command];
    try {
      const r = await this.http.post(
        `/nodes/${node}/qemu/${vmid}/agent/exec`,
        { command: cmd },
        { headers: this.headers() }
      );
      return r.data.data.pid as number;
    } catch (e) {
      this.handleError(e);
    }
  }

  async guestExecStatus(node: string, vmid: number, pid: number): Promise<GuestExecStatus> {
    await this.ensureSession();
    try {
      const r = await this.http.get(
        `/nodes/${node}/qemu/${vmid}/agent/exec-status`,
        { params: { pid }, headers: this.headers() }
      );
      return r.data.data as GuestExecStatus;
    } catch (e) {
      this.handleError(e);
    }
  }

  async guestPing(node: string, vmid: number): Promise<void> {
    await this.ensureSession();
    try {
      await this.http.post(`/nodes/${node}/qemu/${vmid}/agent/ping`, {}, { headers: this.headers() });
    } catch (e) {
      this.handleError(e);
    }
  }

  async waitForTask(
    node: string,
    upid: string,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const pollMs = opts.pollMs ?? 2000;
    await this.ensureSession();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let data: TaskStatus = { status: "running" };
      try {
        const r = await this.http.get(`/nodes/${node}/tasks/${upid}/status`, {
          headers: this.headers(),
        });
        data = r.data.data as TaskStatus;
      } catch (e) {
        this.handleError(e);
      }
      if (data.status === "stopped") {
        if (data.exitstatus !== "OK") {
          throw new Error(`Task ${upid} on ${node} failed: ${data.exitstatus}`);
        }
        return;
      }
      await sleep(pollMs);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for task ${upid} on ${node} (the task may still be running server-side)`
    );
  }

  async waitForGuestAgent(
    node: string,
    vmid: number,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.guestPing(node, vmid);
        return;
      } catch {
        // guest agent not up yet; keep polling until timeout
      }
      await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for guest agent on VM ${vmid} (${node}) after ${timeoutMs}ms`);
  }
}
