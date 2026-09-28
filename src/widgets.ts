import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Build the ext-apps browser bundle (inlined into each widget)
function buildBundle(): string {
  const raw = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8"
  );
  // Rewrite `export { Foo as Bar, ... };` → `globalThis.ExtApps = { Bar: Foo, ... };`
  return raw.replace(/export\{([^}]+)\};?\s*$/, (_match, body: string) => {
    const entries = body.split(",").map((p) => {
      const parts = p.trim().split(/\s+as\s+/);
      const local = parts[0].trim();
      const exported = parts[1]?.trim() ?? local;
      return `${exported}:${local}`;
    });
    return `globalThis.ExtApps={${entries.join(",")}};`;
  });
}

let _bundle: string | null = null;
function getBundle(): string {
  if (!_bundle) _bundle = buildBundle();
  return _bundle;
}

const widgetDir = join(__dirname, "..", "widgets");
const widgetCache = new Map<string, string>();

export function loadWidget(filename: string): string {
  if (widgetCache.has(filename)) return widgetCache.get(filename)!;
  const raw = readFileSync(join(widgetDir, filename), "utf8");
  const html = raw.replace("/*__EXT_APPS_BUNDLE__*/", () => getBundle());
  widgetCache.set(filename, html);
  return html;
}

export const WIDGET_FILES: Record<string, string> = {
  "ui://widgets/vm-picker.html": "vm-picker.html",
  "ui://widgets/vm-confirm.html": "vm-confirm.html",
  "ui://widgets/cluster-status.html": "cluster-status.html",
  "ui://widgets/snapshot-picker.html": "snapshot-picker.html",
  "ui://widgets/snapshot-form.html": "snapshot-form.html",
  "ui://widgets/token-result.html": "token-result.html",
  "ui://widgets/tasks.html": "tasks.html",
  "ui://widgets/pool-browser.html": "pool-browser.html",
  "ui://widgets/vm-detail.html": "vm-detail.html",
  "ui://widgets/migrate-form.html": "migrate-form.html",
  "ui://widgets/clone-form.html": "clone-form.html",
  "ui://widgets/cloud-init-form.html": "cloud-init-form.html",
};
