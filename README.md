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

### Shell identity (for `node_shell`)

`node_shell` runs commands through the terminal behind the web UI **Shell** button. Proxmox VE 8 rejects API tokens when it opens that terminal, so the tool always signs in with a password of its own, whatever `auth` says. Add a `shell` block to `config.json`. The tool is registered only when the block is valid, or when `auth` is already the `root@pam` password.

Root, with no sudo and no login prompt (add `totp` only if root has 2FA):

```json
"shell": {"user": "root@pam", "password": "<root password>", "totp": "<base32 secret>"}
```

A Linux user, who runs commands through `sudo` (set `"sudo": false` to run as that user):

```json
"shell": {"user": "alice", "password": "<alice's Linux password>", "sudo": true}
```

`user` accepts `alice` or `alice@pam`. Any other realm, such as `alice@pve`, is invalid because the terminal login checks Linux accounts, not Proxmox users. An invalid block does not stop the server. It logs `[mcp-proxmox] node_shell disabled: <reason>` to stderr and leaves `node_shell` out. Every other tool keeps working.

A Linux user needs all of the following:

- A Proxmox user `alice@pam` with the `Sys.Console` privilege on `/nodes`.
- A Linux account `alice` with the same password on the API host and on every node you target.
- Sudo rights for that account, unless `sudo` is `false`. The tool answers the sudo prompt with the same password.

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

#### `resize_disk`
Grows a VM or container disk. Disks can only grow, never shrink; the guest filesystem is not resized.

**Inputs:** `vmid`, `node`, `type` (`qemu` default | `lxc`), `disk` (e.g. `scsi0`, `rootfs`), `size` (absolute `100G` or relative `+90G`)

#### `start_vm`
Starts a stopped VM or container. Start-only: cannot stop, reboot, or delete. Returns early if the VM is already running.

**Inputs:** `vmid`, `node`, `type` (`qemu` default | `lxc`), `wait_for_agent` (optional, default `false`; qemu only)

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

### Node shell

#### `node_shell`
Runs a non-interactive bash script on a node and returns the exit code with separate stdout and stderr. It opens the same termproxy and WebSocket session as the web UI **Shell** button, so every call appears as a `vncshell` task in the node's task log. Needs a [shell identity](#shell-identity-for-node_shell).

**Inputs:** `node`, `command` (up to 8192 characters), `timeout_s` (1 to 600, default 60)

- Each call opens a fresh login shell. The working directory and variables do not carry over.
- Stdin is `/dev/null` and there is no TTY. Use batch flags such as `top -b` and `apt-get -y`.
- stdout and stderr are each capped at 32 KiB. The result states the full size when it truncates.
- Exit code `124` means the `timeout_s` limit fired on the node. A command that ignores the first signal is killed 5 seconds later.
- A non-zero exit code marks the result as an error.
- The node needs GNU `base64`, `stat` and `timeout`, which a stock Proxmox VE install has.

> The tool is flagged destructive and runs arbitrary commands with the shell identity's rights, which means root for `root@pam` and for a sudo user. Your MCP client's tool permission prompt is the only confirmation step.

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
| `node_shell` | `Sys.Console` on `/nodes/<node>`, held by the shell user rather than the API token |

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

**`node_shell` is missing**
Check the server's stderr for `node_shell disabled: ...`. Without a `shell` block, `node_shell` exists only when `auth` is the `root@pam` password.

**`node_shell` fails with `rejected the node_shell login`**
Proxmox returned 401 for the shell user's ticket request. Check `shell.password`, and `shell.totp` if that user has 2FA.

**`node_shell` fails with `Login incorrect`**
The ticket worked but the Linux account differs on the target node. Create the same account and password on every node you target.

**`node_shell` fails in phase `awaiting_shell`**
No shell answered within 20 seconds. A shell profile that starts `tmux` or `screen` blocks the call. Remote nodes add an SSH hop from the API host that must also succeed.

**TOTP rejected**
Make sure the base32 secret in config matches your authenticator app exactly. Clock skew of more than 30 seconds will cause failures.
