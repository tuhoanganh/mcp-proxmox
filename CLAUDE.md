# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — compile TypeScript from `src/` to `dist/` (required before Claude Code can load the server; `bin` entries point at `dist/*.js`).
- `npm run dev` — `tsc --watch` for iterative work.
- `npm run setup` / `node dist/setup.js` — interactive wizard that writes `~/.mcp-proxmox/config.json` (mode 600).
- `npm start` — run the stdio MCP server directly (normally Claude Code launches it).
- After editing sources: rebuild, then restart Claude Code to reload the server. There is no test suite.

## Architecture

Stdio MCP server that exposes Proxmox VE cluster management as tools, most of which render an interactive HTML widget via the `@modelcontextprotocol/ext-apps` extension.

**Startup flow (`src/server.ts`):** load config → construct `ProxmoxClient` → create `McpServer` → call each `register*Tools(server, client)` module → register one `registerAppResource` per entry in `WIDGET_FILES` → connect stdio transport. A non-fatal `client.getVersion()` probe logs connection status to stderr but does not block startup on failure.

**Tool modules (`src/tools/*.ts`):** `vms`, `snapshots`, `cluster`, `admin`, `pools`, `migration`. Each exports a single `register*Tools` function. Adding a tool = add it to the appropriate module and (if it renders UI) add a widget file + entry in `WIDGET_FILES`.

**Two-step confirm pattern for destructive/mutating actions:** the user-facing tool (e.g. `vm_action`, `create_snapshot`, `rollback_snapshot`, `migrate_vm`, `create_api_token_form`) is registered with `registerAppTool` and returns JSON metadata that the widget renders as a form or confirm dialog. When the user confirms, the widget posts back and Claude calls the paired `*_execute` tool (registered with plain `server.tool`, no widget) which performs the actual Proxmox API call. Keep this split — never do the mutating call inside the widget-returning tool.

**Widget pipeline (`src/widgets.ts`):** widget HTML lives in `widgets/` and contains a `/*__EXT_APPS_BUNDLE__*/` sentinel. On first `loadWidget()` call, the `@modelcontextprotocol/ext-apps/app-with-deps` browser bundle is read and its trailing `export{...}` statement is rewritten into `globalThis.ExtApps = {...}` so widgets can consume it without ES module semantics. Bundle and per-file rendered HTML are cached in-process. `WIDGET_FILES` maps `ui://widgets/<name>.html` URIs to filenames; the server auto-registers each as an app resource. New widget = drop the file in `widgets/`, add the URI mapping, reference `_meta: { ui: { resourceUri: ... } }` on the tool.

**Proxmox client (`src/proxmox.ts`):** thin axios wrapper around the Proxmox REST API. Auth is delegated to `src/auth.ts`, which supports three modes (API token, password, password + TOTP via `otplib`). Token auth sets an `Authorization: PVEAPIToken=...` header; password auth performs the two-step `/access/ticket` dance (PVECHALLENGE + TOTP) and uses `PVEAuthCookie` + `CSRFPreventionToken`. `insecure: true` (default in setup) disables TLS verification for self-signed certs.

**Config (`src/config.ts`):** single JSON file at `~/.mcp-proxmox/config.json`. The server exits at startup if it's missing.

## Conventions

- ESM only (`"type": "module"`, `NodeNext` resolution). Use `.js` extensions in relative imports even though sources are `.ts`.
- Strict TypeScript. Zod schemas define tool input contracts — keep them in sync with the widget's expected payload shape.
- Widgets are plain HTML with inline CSS/JS; they must render correctly in both light and dark host themes and degrade to text when the app surface is unavailable.
