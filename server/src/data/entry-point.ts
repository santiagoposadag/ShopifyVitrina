import { pathToFileURL } from "node:url";

/**
 * Whether the module asking is the process's entry point.
 *
 * Every ops CLI in this directory ends by CALLING `main()`. In ESM that call
 * runs on IMPORT, not only on execution — so a test, or any module, that
 * imports one of these files to reach a helper inside it runs that CLI's whole
 * default command as a side effect, against the real database at DB_PATH.
 *
 * That is not hypothetical: it happened while `test-console-credentials.ts` was
 * being written. A test imported one exported function and the CLI's default
 * `list` ran against the developer's own `data/vitrina.db`. That one was
 * harmless — an additive CREATE TABLE — but the same shape reaches
 * `purge-sessions.ts`, whose main() DELETES every customer session and, since
 * the conversation record landed, their messages with them.
 *
 * `pathToFileURL` rather than a `file://${argv[1]}` template: a path containing
 * a space, `#` or `?` needs percent-encoding, and the naive form would compare
 * unequal and silently DECLINE to run — an ops tool that exits successfully
 * having done nothing, which is the worst way for this to fail.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}
