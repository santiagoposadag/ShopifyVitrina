# The test console — TEMPORARY, and removable

This documents a feature that only exists while the owner is manually
exercising both sides of the assistant — owner and customer — from their own
phone. It is not part of the product. Section 5 is the removal checklist, and
it is written now, before the door exists, on purpose.

---

## 1. What this is

A small set of pre-registered test phones can flip their OWN role (owner ↔
customer) from a web page, instead of an operator running `role-assignments
set <phone> <role>` on their behalf. It exists so the person testing the
assistant does not need shell access to the server to see both conversation
paths.

Enrolling a phone is a CLI operation only — the console page itself has no way
to add a phone to the roster. See
[server/src/data/test-roster.ts](../server/src/data/test-roster.ts) for why:
nothing served over HTTP may call `addRosterEntry` or `rotateRosterToken`, so
a console that could enrol itself would be a console that grants itself reach.

## 2. Enrolling the owner's phone

```bash
./scripts/with-secrets.sh docker compose --profile ops run --rm test-console \
  add 573001112233 --label "owner's phone"
```

Locally, without compose:

```bash
npm run test-console -w server -- add 573001112233 --label "owner's phone"
```

This prints a LINK, once:

```
Console link for 573001112233 ("owner's phone") is shown ONCE:

  https://your-deploy.example.com/test-console#t=<64 hex chars>

Send it to the phone's holder now. Only its SHA-256 is kept here, so it cannot be
recovered — a lost link is replaced with `rotate`, not looked up. It is a BEARER
CREDENTIAL: whoever holds it can flip that phone's own role, so it must not be
forwarded, pasted into a shared chat, or sent anywhere but directly to that phone.
```

If `PUBLIC_BASE_URL` is unset, or still looks like a placeholder (`localhost`,
`example.com`, and similar), only the path is printed, with a note to prepend
the deployment's real, publicly reachable origin by hand.

> **The token rides the URL fragment (`#t=…`), never a query string.** Fastify
> runs with request logging on, so a `?t=` token would be written into the
> access log on every page load; a fragment is never sent to the server at
> all. Treat the whole link as a bearer credential — the same rule as any
> other token in this repo: it must not be forwarded, screenshotted into a
> group chat, or pasted anywhere but directly to the phone's holder.

Other commands: `list` (phone, label, enrolled/rotated timestamps — never a
token or a hash), `rotate <phone>` (replaces the token, previous link stops
working immediately), `remove <phone>` (revokes; the phone's link stops
working on its next request, no restart).

## 3. Keep test phones OUT of `OWNER_PHONE_NUMBERS`

`OWNER_PHONE_NUMBERS` is only a SEED for the `assignments` table (see
[role-assignments.ts](../server/src/data/role-assignments.ts)); the table row
wins, and only the row is what the console flips. A phone that is in BOTH the
variable and the roster, and that the console has flipped to `customer`,
leaves the variable naming an owner the row disagrees with — the boot seed
logs that disagreement on **every restart**. It is the system working
correctly, not a config error, but it reads like one.

`test-console add` warns when the phone you are enrolling is already in
`OWNER_PHONE_NUMBERS`. The fix is to keep it out of that variable and instead
give it its role once:

```bash
./scripts/with-secrets.sh docker compose --profile ops run --rm role-assignments \
  set 573001112233 owner
```

then enrol it in the roster as above. The row survives restarts on its own;
the variable was never needed for it.

## 4. What the link actually grants

Opening the link authenticates as that ONE phone — `findRosterByToken` in
[test-roster.ts](../server/src/data/test-roster.ts) returns exactly one row,
and that row's phone is the only thing the console can act on. It cannot name
a different phone, list other roster entries, or reach the agent door
(`POST /agents/:id/messages` uses a completely separate credential — see
[agent-registry.ts](../server/src/data/agent-registry.ts)). Losing the link is
not catastrophic — `rotate` replaces it immediately — but treat it as you
would any bearer credential in this repo: do not forward it, do not paste it
into a shared log, and do not leave it sitting in a chat thread longer than it
takes the holder to open it once.

## 5. Removal checklist (read before you need it)

The feature dies immediately at step 1 — no restart, no redeploy — because
authentication is a row lookup in `test_roster`. Everything after that is
cleanup of dead code and dead docs.

1. **Delete every roster row.** For each enrolled phone:
   ```bash
   ./scripts/with-secrets.sh docker compose --profile ops run --rm test-console remove <phone>
   ```
   Or drop the table directly against the running database. Either way, every
   outstanding link stops working the instant this completes.
2. Delete the source files:
   - `server/src/data/test-roster.ts`
   - `server/src/data/test-console-credentials.ts`
   - `server/src/admin/test-console.ts`
   - their test files (`server/test/test-roster.test.ts`,
     `server/test/test-console-credentials.test.ts`, and whatever test file
     covers `server/src/admin/test-console.ts`)
3. Delete the `test_roster` table block from
   [db.ts](../server/src/data/db.ts) (`migrate()`). `CREATE TABLE IF NOT
   EXISTS` never drops anything on its own — an existing database keeps the
   table forever unless a release adds `DROP TABLE IF EXISTS test_roster` to
   `migrate()` for that one deploy.
4. Delete the `test-console` service block from
   [compose.yaml](../compose.yaml).
5. Delete the `test-console` script line from
   [server/package.json](../server/package.json).
6. Delete this file, `docs/test-console.md`, and any link to it (this repo's
   `npm run docs:check` catches a dangling link but not a dangling mention in
   prose).
7. **Old backups still contain the hashes.** `data/backup.ts` snapshots taken
   while this feature was live still have `test_roster` rows in them — the
   hashes are worthless once step 1 has run (nothing they matched still
   exists), but they are not implicitly deleted by any of the steps above. If
   backup retention or export policy matters to you, account for it
   separately; this checklist only covers the live system.
