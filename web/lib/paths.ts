import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Walk up from the current working directory to find the monorepo root — the
 * nearest package.json that declares npm "workspaces". This lets the storefront
 * resolve the SAME DB_PATH / MEDIA_DIR as the server regardless of where the
 * process was started.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // Ignore unreadable package.json and keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return start; // Reached filesystem root.
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(process.cwd());

export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

export function dbPath(): string {
  return resolveDataPath(process.env.DB_PATH?.trim() || "./data/vitrina.db");
}

export function mediaDir(): string {
  return resolveDataPath(process.env.MEDIA_DIR?.trim() || "./data/media");
}
