import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AgentDefinition, ToolUniverse } from "../agent/definition.js";
import { undeclaredToolMentions } from "../agent/definition.js";
import type { DB } from "../data/db.js";
import type { KnowledgeHit, KnowledgePort } from "../tools/ports.js";

/**
 * The knowledge base: an agent's own documents, in two tiers.
 *
 * INLINE goes into the system prompt on every turn, because a resumed
 * transcript carries the prompt and nothing else — a fact the agent must never
 * be without cannot live behind a tool call it may not make. SEARCHABLE is
 * indexed and reached through `search_knowledge`, because long material in the
 * prompt is paid for on every turn AND because the grounding rule is that the
 * agent states what a tool returned. Collapsing the two loses one of those
 * properties whichever way it is collapsed.
 *
 * The documents on disk are the source of truth. The FTS index is DERIVED and
 * disposable: it is rebuilt from them at boot, so the worst a corrupt or
 * deleted index costs is a restart.
 */

/** Where a definition's knowledge documents must live, relative to its own directory. */
export const KNOWLEDGE_DIR = "knowledge";

/**
 * The token budget is enforced against an APPROXIMATION — there is no
 * tokenizer in this build and adding one for a boot check is not worth a
 * dependency.
 *
 * Three characters per token, which for Spanish prose OVERSTATES the real
 * count (a real tokenizer lands nearer four). That direction is the whole
 * point: the estimate must never come in under the truth, or a definition that
 * "fits" its budget silently ships a bigger prompt than the number says. It
 * costs a little unused headroom and cannot cost a blown context.
 */
const CHARS_PER_TOKEN = 3;

/**
 * The largest chunk we index. A chunk is the unit that comes back to the model,
 * so it has to be small enough to be worth reading and big enough to stand
 * alone — a section split mid-argument answers a question with half a policy.
 * Sections shorter than this are never split.
 */
const MAX_CHUNK_CHARS = 1200;

/** How many words of a person's question reach the FTS query. */
const MAX_QUERY_TOKENS = 12;

/**
 * How much of a query word is kept before the prefix wildcard.
 *
 * A crude stemmer, and it earns its place: FTS5's unicode61 tokenizer does not
 * stem, and Spanish inflects the verb people actually ask about. Measured
 * against the shipped documents, "¿cómo publico un producto?" ranked "Retirar
 * un producto de la venta" FIRST — "publico" shares no prefix with "publicar",
 * so the only word that matched was "producto" and the wrong section won on
 * density alone. Truncating to a stem makes publico/publicar/publicado/
 * publicación one query term.
 *
 * Six characters is short enough to cover Spanish verb endings and long enough
 * that the stems stay distinct in a corpus this size; a word shorter than that
 * is used whole (SKU, cm).
 */
const MAX_TERM_PREFIX = 6;

/**
 * Spanish function words, dropped from a query so they cannot outvote the word
 * the person actually asked about.
 *
 * A short, explicit list — not a linguistic model. It is only ever a filter on
 * the QUERY, never on the indexed text, and if every word of a question is on
 * it the question is searched unfiltered rather than answered with nothing.
 */
const QUERY_STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al",
  "que", "qué", "como", "cómo", "cuando", "cuándo", "donde", "dónde", "cual", "cuál",
  "por", "para", "con", "sin", "sobre", "en", "es", "son", "se", "su", "sus",
  "lo", "le", "les", "me", "mi", "yo", "tu", "te", "y", "o", "si", "no",
  "hay", "esta", "este", "esto", "esa", "ese", "eso", "muy", "más", "mas",
  // Interrogatives, accented and not: the query keeps whatever accent the
  // person typed (only the INDEX folds them), so both spellings have to be here
  // or half of them slip through and outrank the word being asked about —
  // "¿cuántas unidades quedan?" ranked the photo section first on "cuántas".
  "cuanto", "cuánto", "cuanta", "cuánta", "cuantos", "cuántos", "cuantas", "cuántas",
  "quien", "quién", "porque", "porqué", "cuál", "cuáles", "cuales",
]);

/** One indexable piece of one document. */
export interface KnowledgeChunk {
  /** The document's file name, e.g. "glosario.md". What a citation names. */
  source: string;
  /** Position within its document, so a split section can be put back in order. */
  ordinal: number;
  heading: string;
  body: string;
}

/** What prompt.ts needs to render the knowledge section, and nothing more. */
export interface PromptKnowledge {
  /** The inline documents, already joined. Empty when the agent has none. */
  inlineText: string;
  /**
   * Whether this agent has a searchable tier. The prompt's instruction to use
   * `search_knowledge` is written ONLY when this is true — telling an agent to
   * call a tool it was not given is the hole the boot validator exists to close.
   */
  hasSearchable: boolean;
}

/** One agent's knowledge, loaded and checked. */
export interface AgentKnowledge {
  agentId: string;
  prompt: PromptKnowledge;
  /** The searchable tier only. The inline tier is never indexed: it is always present. */
  chunks: KnowledgeChunk[];
  /** The estimate the budget was checked against, kept for the boot log. */
  inlineTokens: number;
}

/**
 * The reader the runtime and the tool share. `promptFor` feeds prompt
 * composition; `search` is the tool's only door, and it is the port's shape, so
 * a tool cannot reach anything wider.
 */
export interface KnowledgeBase extends KnowledgePort {
  promptFor(agentId: string): PromptKnowledge | undefined;
}

/** Tokens, approximately and deliberately on the high side. See CHARS_PER_TOKEN. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** An ATX heading line ("# Title", "## Section"), captured without its hashes. */
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/**
 * Split one document into chunks.
 *
 * One heading, one chunk: a section is written to be read on its own, which is
 * exactly what a retrieved chunk has to be. The heading is stored BESIDE the
 * body rather than inside it, so the renderer decides once how a chunk is shown
 * and a heading cannot be double-printed into the model's context.
 *
 * A section too long to be one chunk is split on paragraph boundaries and every
 * piece keeps the heading, because a fragment that arrives without the section
 * it belongs to is a fragment the model has to guess the subject of.
 */
export function chunkDocument(source: string, text: string): KnowledgeChunk[] {
  const sections: { heading: string; lines: string[] }[] = [];
  // Text before the first heading belongs to the file itself. Naming the file
  // beats an empty heading: a citation with no name tells nobody where to look.
  let current = { heading: source, lines: [] as string[] };

  for (const line of text.split("\n")) {
    const match = HEADING.exec(line);
    if (match) {
      sections.push(current);
      current = { heading: match[1] ?? source, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    // A heading with nothing under it indexes a title against no content: it
    // can win a search and then answer with nothing.
    if (body.length === 0) continue;
    for (const piece of splitBody(body)) {
      chunks.push({ source, ordinal: chunks.length, heading: section.heading, body: piece });
    }
  }
  return chunks;
}

/** Pack paragraphs into pieces of at most MAX_CHUNK_CHARS, never splitting one that fits. */
function splitBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const pieces: string[] = [];
  let buffer = "";
  for (const paragraph of body.split(/\n\s*\n/)) {
    const candidate = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      buffer = candidate;
      continue;
    }
    if (buffer.length > 0) pieces.push(buffer);
    buffer = "";
    // One paragraph longer than the whole budget: cut it. Ugly, and still
    // better than an entry no search can ever return because it was dropped.
    if (paragraph.length > MAX_CHUNK_CHARS) {
      for (let at = 0; at < paragraph.length; at += MAX_CHUNK_CHARS) {
        pieces.push(paragraph.slice(at, at + MAX_CHUNK_CHARS));
      }
    } else {
      buffer = paragraph;
    }
  }
  if (buffer.length > 0) pieces.push(buffer);
  return pieces;
}

interface LoadedDocument {
  /** Path as the definition wrote it, for error messages. */
  declared: string;
  /** File name only, which is what a citation shows and what the index stores. */
  source: string;
  text: string;
}

/**
 * Read, check and chunk one agent's knowledge.
 *
 * Every failure here is a DEPLOY-TIME mistake — a path that does not exist, a
 * document nothing declares, a budget that cannot be met — so every one of them
 * throws. Following index.ts's own distinction: a credential may not block
 * startup because the inbox is durable and messages replay once it is fixed,
 * but a definition that cannot be loaded correctly will not fix itself, and an
 * agent booted with half its knowledge answers confidently from the half it has.
 */
export function loadAgentKnowledge(
  agentsDir: string,
  definition: AgentDefinition,
  universe: ToolUniverse,
): AgentKnowledge {
  const agentDir = join(agentsDir, definition.id);
  const knowledgeDir = resolve(agentDir, KNOWLEDGE_DIR);
  const spec = definition.knowledge;

  const read = (declared: string): LoadedDocument => {
    if (isAbsolute(declared)) {
      throw new Error(
        `Agent "${definition.id}": knowledge document "${declared}" is an absolute path; ` +
          `every document must live under ${KNOWLEDGE_DIR}/ inside the agent's own directory`,
      );
    }
    const full = resolve(agentDir, declared);
    // A definition is DATA, edited per business without a deploy. A data file
    // that can name a path outside its own directory can read a credential file
    // straight into a system prompt, and the prompt is not something anyone
    // reads after it ships.
    if (!full.startsWith(knowledgeDir + sep)) {
      throw new Error(
        `Agent "${definition.id}": knowledge document "${declared}" resolves outside ` +
          `${knowledgeDir}; every document must live under ${KNOWLEDGE_DIR}/`,
      );
    }
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Agent "${definition.id}": could not read knowledge document ${full}: ${detail}`,
      );
    }
    return { declared, source: full.slice(knowledgeDir.length + 1), text };
  };

  const inline = spec.inline.map(read);
  const searchable = spec.searchable.map(read);

  assertEveryDocumentIsDeclared(definition, knowledgeDir, [...inline, ...searchable]);

  // The same check the boot validator runs over prompt.md, for the same reason:
  // a document that tells the agent to call a tool it was not given produces an
  // agent asking for something that does not exist — and knowledge reaches the
  // model exactly like the prompt does, inline or as a tool result.
  for (const doc of [...inline, ...searchable]) {
    const undeclared = undeclaredToolMentions(doc.text, definition, universe);
    if (undeclared.length > 0) {
      throw new Error(
        `Agent "${definition.id}": knowledge document "${doc.declared}" mentions ` +
          `${undeclared.map((n) => `"${n}"`).join(", ")}, which is not in tools[]`,
      );
    }
  }

  const inlineText = inline
    .map((doc) => doc.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  const inlineTokens = estimateTokens(inlineText);

  // Fails, and deliberately does NOT truncate. Truncation is the invisible
  // option: half a policy reaches the model, reads exactly like a whole one,
  // and the owner has no way to find out which half was cut.
  if (inline.length > 0 && spec.maxInlineTokens <= 0) {
    throw new Error(
      `Agent "${definition.id}": declares ${inline.length} inline knowledge document(s) ` +
        `(${inline.map((d) => d.declared).join(", ")}) against maxInlineTokens: ` +
        `${spec.maxInlineTokens}. Inline knowledge is never truncated — raise the budget ` +
        `or move the document to knowledge.searchable.`,
    );
  }
  if (inlineTokens > spec.maxInlineTokens) {
    throw new Error(
      `Agent "${definition.id}": inline knowledge is about ${inlineTokens} tokens ` +
        `(estimated at ${CHARS_PER_TOKEN} characters per token, which overstates the real ` +
        `count) but maxInlineTokens is ${spec.maxInlineTokens}. Documents: ` +
        `${inline.map((d) => d.declared).join(", ")}. Raise the budget or move a document ` +
        `to knowledge.searchable — inline knowledge is never truncated.`,
    );
  }

  return {
    agentId: definition.id,
    prompt: { inlineText, hasSearchable: searchable.length > 0 },
    chunks: searchable.flatMap((doc) => chunkDocument(doc.source, doc.text)),
    inlineTokens,
  };
}

/**
 * Every `.md` file under `knowledge/` must be declared by one of the tiers.
 *
 * The failure this prevents is silent from every angle: the owner writes a
 * policy, ships it, sees the file in the repository, and no turn can ever reach
 * it because nothing named it. The agent simply does not know the thing it was
 * told, and answers anyway.
 */
function assertEveryDocumentIsDeclared(
  definition: AgentDefinition,
  knowledgeDir: string,
  declared: LoadedDocument[],
): void {
  let present: string[];
  try {
    // RECURSIVE, and it has to be: a declared path may name a subdirectory
    // (its `source` is then "sub/x.md"), so a top-level-only scan would let an
    // undeclared document hide one directory down — which is the same silent
    // failure this check exists to prevent, with an extra folder in front of it.
    present = readdirSync(knowledgeDir, { recursive: true, encoding: "utf8" }).filter((name) =>
      name.endsWith(".md"),
    );
  } catch {
    // No knowledge directory at all. Legitimate — an agent may have none — and
    // a declared document would already have failed to read above.
    return;
  }
  const named = new Set(declared.map((doc) => doc.source));
  const orphans = present.filter((name) => !named.has(name));
  if (orphans.length > 0) {
    throw new Error(
      `Agent "${definition.id}": ${orphans.map((n) => `${KNOWLEDGE_DIR}/${n}`).join(", ")} ` +
        `exist(s) but no tier declares them. A knowledge document nothing declares is one ` +
        `nobody can reach — add it to knowledge.inline or knowledge.searchable, or delete it.`,
    );
  }
}

/**
 * A digest of exactly what would be indexed, so an unchanged boot writes nothing.
 *
 * The fields are separated by a byte that cannot occur in a document, because
 * plain concatenation makes heading "ab" + body "c" hash the same as heading
 * "a" + body "bc" — two different indexes a boot would then call unchanged.
 *
 * The separator is written as the ESCAPE `\u0000`, never as the literal byte. A
 * raw NUL in a source file makes `file` report it as `data` and makes `grep`
 * answer "binary file matches" instead of printing the line — and this
 * repository is navigated by grep, cites `file:line` from CLAUDE.md and the
 * wiki, and checks those citations in scripts/check-docs.sh. A file nobody can
 * grep is a file nobody can cite, and an editor may strip the bytes silently on
 * the next save. `\u0000` and not `\0`: the latter is the octal-escape shape and
 * changes meaning the moment someone appends a digit to it.
 *
 * The composed string is identical either way, so this is an encoding fix and
 * not a hash change: no deployed database re-indexes because of it.
 */
function contentHash(chunks: readonly KnowledgeChunk[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(
      `${chunk.source}\u0000${chunk.ordinal}\u0000${chunk.heading}\u0000${chunk.body}\u0000`,
    );
  }
  return hash.digest("hex");
}

/**
 * Put one agent's chunks in the index, idempotently.
 *
 * Boot is at-least-once in practice — a restart is routine and a redeploy runs
 * this again — so the operation is REPLACE, never append: delete this agent's
 * rows, insert the current ones. Both are inside ONE transaction, so a reader
 * (a turn in another process against the same file, under WAL) sees the old set
 * or the new set and never a half-emptied index, and a crash between the two
 * leaves the previous content intact for the next boot to replace.
 *
 * The content hash short-circuits the case where nothing changed, which is
 * every ordinary restart: no write, no write lock, nothing for a concurrent
 * booter or a running turn to wait on.
 *
 * IMMEDIATE, for the same reason the sessions rebuild is: a deferred
 * transaction takes its read lock first and discovers a competing writer only
 * when it tries to upgrade. Taking the write lock up front makes a second
 * booting process block, then re-read the hash inside the lock and find the
 * work already done.
 */
export function indexAgentKnowledge(db: DB, agent: AgentKnowledge): "indexed" | "unchanged" {
  const hash = contentHash(agent.chunks);
  const write = db.transaction((): "indexed" | "unchanged" => {
    const row = db
      .prepare(`SELECT content_hash FROM knowledge_index WHERE agent_id = ?`)
      .get(agent.agentId) as { content_hash: string } | undefined;
    if (row?.content_hash === hash) return "unchanged";

    db.prepare(`DELETE FROM knowledge_chunks WHERE agent_id = ?`).run(agent.agentId);
    const insert = db.prepare(
      `INSERT INTO knowledge_chunks (agent_id, source, ordinal, heading, body)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const chunk of agent.chunks) {
      insert.run(agent.agentId, chunk.source, chunk.ordinal, chunk.heading, chunk.body);
    }
    db.prepare(
      `INSERT INTO knowledge_index (agent_id, content_hash, chunk_count, indexed_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         chunk_count = excluded.chunk_count,
         indexed_at = excluded.indexed_at`,
    ).run(agent.agentId, hash, agent.chunks.length);
    return "indexed";
  });
  return write.immediate();
}

/** How many chunks this agent currently has indexed. For the boot log and for tests. */
export function countIndexedChunks(db: DB, agentId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE agent_id = ?`)
    .get(agentId) as { n: number };
  return row.n;
}

/**
 * Delete everything indexed for agents this runtime does not serve.
 *
 * An agent renamed or removed from the definitions leaves rows nothing reads
 * and nothing replaces — invisible, because a scoped search never sees them.
 * Safe to do bluntly: the index is derived from files, so the cost of deleting
 * too much is one boot, and `agentIds` is the full served list by contract of
 * the one caller (loadKnowledgeBase).
 */
function sweepUnknownAgents(db: DB, agentIds: readonly string[]): number {
  const keep = new Set(agentIds);
  const known = db.prepare(`SELECT DISTINCT agent_id FROM knowledge_chunks`).all() as {
    agent_id: string;
  }[];
  let removed = 0;
  for (const { agent_id } of known) {
    if (keep.has(agent_id)) continue;
    removed += countIndexedChunks(db, agent_id);
    db.transaction(() => {
      db.prepare(`DELETE FROM knowledge_chunks WHERE agent_id = ?`).run(agent_id);
      db.prepare(`DELETE FROM knowledge_index WHERE agent_id = ?`).run(agent_id);
    }).immediate();
  }
  return removed;
}

/**
 * Index the given agents and hand back the reader.
 *
 * Does NOT sweep: it indexes what it is given and touches nobody else, so it is
 * safe for a caller holding a subset. `loadKnowledgeBase` is the boot path and
 * is the one that knows the full list.
 */
export function openKnowledgeBase(db: DB, agents: readonly AgentKnowledge[]): KnowledgeBase {
  const prompts = new Map<string, PromptKnowledge>();
  for (const agent of agents) {
    indexAgentKnowledge(db, agent);
    // An agent with nothing gets no entry at all, so `promptFor` returns
    // undefined and its composed prompt is byte-for-byte what it was before
    // this phase existed.
    if (agent.prompt.inlineText.length > 0 || agent.prompt.hasSearchable) {
      prompts.set(agent.agentId, agent.prompt);
    }
  }
  return {
    promptFor: (agentId) => prompts.get(agentId),
    search: async (input) => searchChunks(db, input),
  };
}

/**
 * The boot path: load every definition's knowledge, index it, drop what no
 * longer belongs, and return the base the runtime and the tools share.
 */
export function loadKnowledgeBase(input: {
  db: DB;
  agentsDir: string;
  definitions: readonly AgentDefinition[];
  universe: ToolUniverse;
}): KnowledgeBase {
  const { db, agentsDir, definitions, universe } = input;
  const agents = definitions.map((definition) =>
    loadAgentKnowledge(agentsDir, definition, universe),
  );
  sweepUnknownAgents(db, definitions.map((d) => d.id));
  return openKnowledgeBase(db, agents);
}

/**
 * Turn a person's words into an FTS5 query.
 *
 * The query arrives from the MODEL, quoting a person, so it is prose and not a
 * query language: unescaped, `"` is a syntax error that fails the turn and `-`,
 * `*` or `NEAR` are operators nobody meant to write. Every word is re-quoted as
 * a literal, which makes the grammar ours rather than the sentence's.
 *
 * Each term is truncated to a stem and given a trailing `*`, which is
 * deliberate and is what makes "publico" find "publicar": Spanish inflects, the
 * index folds accents but does not stem, and an exact-word query answers a
 * perfectly ordinary question with the wrong section. See MAX_TERM_PREFIX.
 *
 * Returns null when nothing searchable is left, which the caller answers with
 * no results rather than with everything.
 */
function matchExpression(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);
  if (words.length === 0) return null;
  const meaningful = words.filter((w) => !QUERY_STOPWORDS.has(w));
  const chosen = (meaningful.length > 0 ? meaningful : words).slice(0, MAX_QUERY_TOKENS);
  // The regex above admits only letters and digits, so nothing here can close
  // the quote; the replace is belt and braces against that regex changing.
  return chosen
    .map((word) => `"${word.slice(0, MAX_TERM_PREFIX).replaceAll('"', "")}"*`)
    .join(" OR ");
}

const DEFAULT_SEARCH_LIMIT = 3;
const MAX_SEARCH_LIMIT = 10;

/**
 * The ONLY read of the index, and it is scoped in SQL.
 *
 * `agent_id` is a bound parameter of a query that always names it, and the
 * column is UNINDEXED so no MATCH expression can address it. There is no
 * unscoped variant of this function to call by accident, and `agentId` reaches
 * it from the turn (which the router set from the transport), never from
 * anything the model or the person wrote.
 */
function searchChunks(
  db: DB,
  input: { agentId: string; query: string; limit?: number },
): KnowledgeHit[] {
  const match = matchExpression(input.query);
  if (match === null) return [];
  // The model chooses `limit`, so it is clamped rather than trusted: a bound
  // that is not a usable integer becomes the default instead of reaching SQLite
  // as a binding it would refuse, which would fail the turn over a detail.
  const requested = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;
  const rows = db
    .prepare(
      `SELECT agent_id, source, heading, body,
              bm25(knowledge_chunks, 0.0, 0.0, 0.0, 5.0, 1.0) AS score
         FROM knowledge_chunks
        WHERE agent_id = ? AND knowledge_chunks MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .all(input.agentId, match, limit) as {
    agent_id: string;
    source: string;
    heading: string;
    body: string;
  }[];
  return rows.map((row) => ({
    agentId: row.agent_id,
    source: row.source,
    heading: row.heading,
    body: row.body,
  }));
}
