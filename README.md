# mcp-proxmox

A Claude Code MCP server for managing Proxmox VE clusters with interactive UI widgets — VM lifecycle, snapshots, cluster monitoring, and API token management, all from within Claude.

## Prerequisites

- Node.js 18+
- Proxmox VE 7.0+
- Claude Code (CLI or Desktop)

## Installation

```bash
cd ~/.claude/mcp-servers/mcp-proxmox
npm install
npm run build
```

Register globally (if not already done):

```bash
claude mcp add proxmox -s user -- /opt/homebrew/bin/node /Users/$(whoami)/.claude/mcp-servers/mcp-proxmox/dist/server.js
```

## First-time Setup

Run the interactive setup wizard to configure your Proxmox host and authentication:

```bash
node dist/setup.js
```

Config is written to `~/.mcp-proxmox/config.json` with mode `600`. Restart Claude Code after setup.

### Auth modes

| Mode | When to use |
|---|---|
| API token | Recommended for automation. Fine-grained permissions via privilege separation. |
| Username + password | Simple but gives full user permissions. |
| Username + password + TOTP | Use when your account has 2FA enabled. |

**API token format:** `user@realm!tokenid=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

Example config:

```json
{
  "host": "192.168.1.100",
  "port": 8006,
  "insecure": true,
  "auth": {
    "type": "apitoken",
    "token": "root@pam!claude=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

> `insecure: true` skips TLS certificate verification — required for Proxmox's default self-signed certificate.

## Tools

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
Check that `~/.mcp-proxmox/config.json` exists. Run `node dist/setup.js` if not.

**401 Unauthorized**
Your API token or password is wrong, or the session expired. Re-run setup.

**403 Permission denied**
The token/user lacks the required privilege for that operation. Check the permissions table above.

**TLS errors**
Set `"insecure": true` in `~/.mcp-proxmox/config.json` if Proxmox uses a self-signed certificate.

**TOTP rejected**
Make sure the base32 secret in config matches your authenticator app exactly. Clock skew of more than 30 seconds will cause failures.
