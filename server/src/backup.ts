import Database from "better-sqlite3";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, resolveDataPath } from "./config.js";

/**
 * Consistent SQLite snapshot via the online backup API — safe while the server
 * is writing (WAL), unlike copying the file. Writes
 * BACKUP_DIR/vitrina-<stamp>.db and prunes snapshots beyond BACKUP_KEEP.
 *
 * Run under compose:  docker compose --profile backup run --rm backup
 * Copied to the host: ./scripts/backup.sh   (see its cron example)
 * Locally:            npm run backup -w server
 */

const KEEP_DEFAULT = 14;
const SNAPSHOT_RE = /^vitrina-\d{8}-\d{6}\.db$/;

function stamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}

async function main(): Promise<void> {
  loadDotEnv();
  const dbPath = resolveDataPath(process.env["DB_PATH"]?.trim() || "./data/vitrina.db");
  const backupDir = resolveDataPath(process.env["BACKUP_DIR"]?.trim() || "./data/backups");
  const keepRaw = Number.parseInt(process.env["BACKUP_KEEP"]?.trim() || "", 10);
  const keep = Number.isNaN(keepRaw) || keepRaw < 1 ? KEEP_DEFAULT : keepRaw;

  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `vitrina-${stamp()}.db`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  console.log(`Backup written: ${dest}`);

  // Stamps sort lexicographically, so the oldest snapshots come first.
  const stale = readdirSync(backupDir)
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort()
    .slice(0, -keep);
  for (const file of stale) {
    unlinkSync(join(backupDir, file));
  }
  if (stale.length > 0) {
    console.log(`Pruned ${stale.length} old snapshot(s); keeping the ${keep} most recent`);
  }
}

main().catch((err: unknown) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
