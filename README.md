# mcp-proxmox

A Claude Code MCP server for managing Proxmox VE clusters with interactive UI widgets — VM lifecycle, snapshots, cluster monitoring, and API token management, all from within Claude.

## Prerequisites

- Node.js 18+
- Proxmox VE 7.0+
- Claude Code (CLI or Desktop)

## Installation

```bash
claude mcp add proxmox -s user -- npx -y mcp-proxmox
```

Restart Claude Code. The server always starts; until it is configured it exposes a single `setup_proxmox` tool.

> **Local development:** clone the repo, then `npm install && npm run build` and register `node /path/to/mcp-proxmox/dist/server.js` instead of the npx command.

## Configuration

Pick one of three options. The config lives at `~/.mcp-proxmox/config.json` (mode `600`). Restart Claude Code afterwards if you used option 2 or 3.

1. **Ask Claude.** In Claude Code say "set up proxmox". Claude calls `setup_proxmox`, which opens a form for the connection details and tests the connection before saving. Secrets entered in the form do not pass through the model. Clients without form support fall back to Claude asking in chat, where secrets end up in the transcript; use option 2 or 3 to avoid that.
2. **Run the wizard.** `npx -y -p mcp-proxmox mcp-proxmox-setup`
3. **Edit the file by hand.** Create `~/.mcp-proxmox/config.json`, then `chmod 600 ~/.mcp-proxmox/config.json`.

API token:

```json
{"host":"<proxmox_ip>","port":8006,"auth":{"type":"apitoken","token":"<username>@pam!<token_id>=<token_secret>"},"insecure":true}
```

Password:

```json
{"host":"<proxmox_ip>","port":8006,"auth":{"type":"password","username":"<username>@pam","password":"<password>"},"insecure":true}
```

Password with 2FA (add a base32 `totp` secret to `auth`):

```json
{"host":"<proxmox_ip>","port":8006,"auth":{"type":"password","username":"<username>@pam","password":"<password>","totp":"<base32 secret>"},"insecure":true}
```

> `insecure: true` skips TLS certificate verification, required for Proxmox's default self-signed certificate.

### Auth modes

| Mode | When to use |
|---|---|
| API token | Recommended for automation. Fine-grained permissions via privilege separation. |
| Username + password | Simple but gives full user permissions. |
| Username + password + TOTP | Use when your account has 2FA enabled. |

**API token format:** `user@realm!tokenid=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

## Tools

### Setup

#### `setup_proxmox`
Only available while no config exists. Call it with no arguments: it opens two forms (host, port, auth type, TLS; then the credentials for that auth type) through MCP elicitation, so secrets never pass through the model. Declining either form cancels without saving. Clients that cannot show forms can pass `host`, `port` (default 8006), `auth` (`apitoken` with `token`, or `password` with `username`, `password`, optional `totp`) and `insecure` (default true) instead. Tests the connection, saves the config on success, then replaces itself with the full tool set.

---

### VM Management

#### `list_vms`
Lists all VMs and LXC containers across all nodes. Opens an interactive picker widget — search by name or VMID, filter by status or type, click to select.

**Optional inputs:**
- `node` — filter to a specific node
- `status` — `running` | `stopped` | `all` (default)
- `type` — `qemu` | `lxc` | `all` (default)

#### `vm_action`
Shows a confirmation dialog before performing a lifecycle action on a VM or container.

**Inputs:** `vmid`, `node`, `type`, `action`

**Actions:** `start` · `stop` · `reboot` · `shutdown` · `reset` · `suspend` · `resume` · `delete`

> Destructive actions (delete, reset) show a red warning. After confirming, Claude calls `vm_action_execute` to dispatch the task.

#### `vm_action_execute`
Executes a confirmed VM action. Called automatically after confirmation — do not call directly.

---

### Snapshots

#### `list_snapshots`
Lists all snapshots for a VM or container in an interactive browser. Click a snapshot to select it for rollback.

**Inputs:** `vmid`, `node`, `type`

#### `create_snapshot`
Opens a form widget to fill in snapshot details.

**Inputs:** `vmid`, `node`, `type`

Fields: name (required), description, include RAM state (QEMU only).

#### `create_snapshot_execute`
Creates the snapshot after the form is submitted.

#### `rollback_snapshot`
Shows a destructive confirmation dialog before rolling back.

**Inputs:** `vmid`, `node`, `type`, `snapname`

#### `rollback_snapshot_execute`
Executes the rollback after confirmation.

#### `delete_snapshot`
Deletes a snapshot immediately (no widget — confirm intent in conversation first).

**Inputs:** `vmid`, `node`, `type`, `snapname`

---

### Cluster & Nodes

#### `get_cluster_status`
Displays a dashboard widget with:
- Cluster summary: node count, VM/CT count, running count
- Per-node CPU / RAM / disk bar charts (pure CSS, no canvas)

#### `get_node_tasks`
Shows recent task log entries in a table widget with status badges.

**Optional inputs:**
- `node` — specific node, or omit for all nodes
- `limit` — max tasks (default 50, max 200)

---

### Admin

#### `create_api_token_form`
Opens a form to create a new Proxmox API token. Requires `Sys.Modify` privilege on `/`.

**Optional input:** `userid` — defaults to the authenticated user

Form fields: user, token ID, expiry date, privilege separation toggle.

#### `create_api_token_execute`
Creates the token and shows the secret **once** in a widget with a Copy button. Store it immediately — Proxmox does not show the secret again.

---

## Widget overview

| Tool | Widget type |
|---|---|
| `list_vms` | Searchable list picker |
| `vm_action` | Color-coded confirm dialog |
| `get_cluster_status` | Resource bar charts |
| `list_snapshots` | Snapshot browser |
| `create_snapshot` | Form |
| `rollback_snapshot` | Destructive confirm dialog |
| `create_api_token_form` / `_execute` | Form + one-time token reveal |
| `get_node_tasks` | Task log table |

Widgets follow the host's light/dark theme automatically. If the claude.ai app surface is unavailable, all tools degrade gracefully — Claude sees the raw JSON data and responds in text.

---

## Updating

After editing source files, rebuild:

```bash
cd ~/.claude/mcp-servers/mcp-proxmox
npm run build
```

Restart Claude Code to reload the server.

## Required Proxmox permissions

| Operation | Required privilege |
|---|---|
| List nodes / VMs | `VM.Audit` on `/` |
| Start / stop / reboot | `VM.PowerMgmt` on the VM |
| Delete VM | `VM.Allocate` on the VM |
| Snapshots (list/create/rollback/delete) | `VM.Snapshot` on the VM |
| Task log | `Sys.Audit` on the node |
| Create API token | `Sys.Modify` on `/` |

A role with `VM.Audit + VM.PowerMgmt + VM.Snapshot + Sys.Audit` covers everything except token creation and VM deletion.

## Troubleshooting

**Server not connecting**
Check that `~/.mcp-proxmox/config.json` exists. If not, ask Claude to "set up proxmox" or run `npx -y -p mcp-proxmox mcp-proxmox-setup`.

**401 Unauthorized**
Your API token or password is wrong, or the session expired. Re-run setup (`npx -y -p mcp-proxmox mcp-proxmox-setup`).

**403 Permission denied**
The token/user lacks the required privilege for that operation. Check the permissions table above.

**TLS errors**
Set `"insecure": true` in `~/.mcp-proxmox/config.json` if Proxmox uses a self-signed certificate.

**TOTP rejected**
Make sure the base32 secret in config matches your authenticator app exactly. Clock skew of more than 30 seconds will cause failures.
