# Delegation brief template

Every section earns its place: each one exists because omitting it produced a bad slice.

## Language contract (non-negotiable)

- Code, identifiers, comments, test names: **English**.
- User-facing UI copy: **Spanish** (RNF-01). Vocabulary rule RNF-02: say "usuario", NEVER
  "paciente" — `pnpm lint:vocabulary` enforces it.

## Read first

List the exact files, with line numbers where it matters: the story under
`e2e/historias/`, the authoritative definition under `definitions/`, and the closest
existing analogue to copy structure from. Naming the analogue is what keeps a slice
consistent with the repo instead of inventing a second style.

## What ALREADY EXISTS — do not rebuild it

Say what works and cite it. Correct any stale claim in the story's "Estado en el código"
yourself, before the agent trusts it — those notes rot, and an agent that believes one
rebuilds something that already works.

## Scope

State the outcome, not the implementation. Let the agent design, but list the constraints
it must satisfy — status codes, row scope, idempotency, what must survive.

## Decisions already made — do not re-open

Name the resolved decisions and their values. List the accepted assumptions the agent must
NOT report as findings; a reviewer returning a decision you already took wastes attention.

## Decisions NOT made — do not invent

If a criterion depends on an unwritten business rule: implement the rest, state the
assumption in code, and propose a `D-NN`. Say this explicitly — silence gets read as
permission to choose.

## Tests

Strict TDD: write the spec first, watch it fail, then implement. Name the spec file and the
analogue to copy. Anything phrased "calling the API directly" must be probed against the
API, never only through the UI. Prefer unit tests for pure logic, e2e only for what needs
the running system.

Add: do not loosen, edit or delete an existing assertion to make the suite pass — report
the conflict instead.

## Environment

Servers are already running (web :3000, api :3001, Postgres in docker). Do NOT start,
restart or reseed them. Give the demo credentials and ids. **Tell the agent to mint its own
fixtures** rather than booking against the shared demo specialist.

## Definition of done

`pnpm typecheck` and `pnpm test` clean; state the exact current baselines
("117 passed / 2 skipped / 0 failed", "163 unit") so a regression is arithmetic, not
judgement. Note that `pnpm lint` is currently a no-op — no package defines a `lint` script,
so only `lint:vocabulary` runs. **Do NOT commit** — the orchestrator commits.

## Report back

Files changed; the design choice and why; exact test counts; what was registered as debt;
anything unsatisfied with the precise reason. Close with: "Be honest about gaps — I verify
the tree and run the suite independently." Say it, then actually do it.
