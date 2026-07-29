# nri [ˈɛnɹi]

![Logo](./logo.png)

**Adaptive agentic-engineering harness** — a LangGraph-based agent that routes
each request through a triage layer into a lightweight **FAST_PATH** patch loop
or a full **HEAVY_PATH** tree-decomposition loop, validates every plan against
your business rules *before* code is written, iterates until a test-coverage
target is met, and applies the resulting diff back to your repo with a single
`y` (or hands-free in yolo mode).

- npm: [`@gg582/nri`](https://www.npmjs.com/package/@gg582/nri)
- git: [`gg582/nri`](https://github.com/gg582/nri)

```bash
npm install -g @gg582/nri
# or from source:
git clone https://github.com/gg582/nri.git && cd nri && npm install && npm run build && npm link
```

## Why nri

Most coding agents improvise their way through a repo. nri runs a deliberate
pipeline instead:

- **Right-sized rigor** — a Step-0 triage scores each request
  (`is_bugfix`, `codebase_impact_ratio`) and sends small fixes down a cheap
  FAST loop (patch → verify) and architectural work down the full HEAVY loop.
  You don't pay tree-of-thought prices for a one-line patch.
- **Business logic is a first-class gate** — on the HEAVY path, a
  contextualization node extracts domain constraints and impacted flows up
  front, and a **pre-flight auditor** simulates the plan against them *before*
  any code is committed. Patches that merely chase coverage numbers while
  breaking domain rules are rejected.
- **Abstract-graph planning** — task trees are clustered into primal nodes
  with I/O contracts; cycles are detected and linearized before detailed
  planning. Cheaper tokens, no runaway loops.
- **Coverage-driven termination** — loops stop at a *measured* test-coverage
  target (via MCP tool calls or your own test command), with iteration and
  pre-flight guardrails, not at "looks good to me".
- **It acts like an agent, not a printer** — detected changes (unified diff or
  file blocks) are summarized and applied with `y/n`, or automatically in
  `yolo` mode, with path sandboxing and automatic `.nri-backup/` snapshots.
- **Multi-provider by design** — OpenAI, Gemini, Kimi, DeepSeek, Grok and
  Claude behind a strategy pattern, with **per-node model routing**: strong
  models for decomposition/implementation, cheap ones for triage/eval.
- **Controlled-English in, your language out** — requests are normalized into
  machine-friendly English for the whole reasoning chain; only the final
  output is localized (`--locale ko`, `uk`, `au`, `ie`, ...).

## Who it's for

- **Teams maintaining business-critical code** (fintech, commerce, ops) where
  "tests pass" is not enough and domain invariants must survive every patch.
- **Power users of multiple LLM providers** who want to mix models per
  pipeline stage and import credentials from clients they already use
  (kimi-code, codex).
- **Agent-framework builders** looking for a readable reference harness:
  triage routing, HITL checkpoints, pre-flight audits, MCP tool integration,
  context compaction — all in plain TypeScript.

If you want a zero-friction autocomplete, this is not that. nri is a harness
for work you want done *verifiably*.

## Quick start

```bash
export GEMINI_API_KEY=...            # or OPENAI_API_KEY / ANTHROPIC_API_KEY / ...

nri                                  # interactive console (default mode)
nri "fix the off-by-one in checkout" # console, task pre-submitted
nri --cli -p gemini -c 80 -r "fix the off-by-one in checkout totals"   # one-shot
nri --cli -r "refactor the billing module" --yolo    # auto-apply detected changes
nri help                             # full CLI reference (also: --help)
```

One-shot output is opt-in via `--cli`; everything else opens the console.
Dry runs without a test suite: `NRI_TEST_MODE=mock nri --cli ...`
Real coverage: point `NRI_MCP_SERVER_COMMAND` at an MCP server with a coverage
tool, or set `NRI_TEST_COMMAND` (default `npm test -- --coverage`).

## The pipeline

```
raw request
  └─ normalize        non-Latin scripts -> controlled English (English requests skip the call)
  └─ triage           { is_bugfix, codebase_impact_ratio } -> FAST_PATH | HEAVY_PATH

FAST   fast_patch ────────────────────────────────────────────► test_runner
HEAVY  business_context ──► decompose ──► abstract_graph ──► proposal
              ▲                            ──► human_approval (HITL) ──► pre_flight
              │                                                     valid │
              └──── synthesis question ◄── evaluate ◄─ implement ◄────────┘
                                            invalid → re-plan (≤3)
test_runner ── coverage ≥ target ? ──► visual? ──► docs? ──► finalize ──► END
                     └ no ──► loop (fast_patch | decompose)
finalize          localized final output (--locale / NRI_LOCALE / config);
                  English locales skip the egress call
```

Token discipline is deliberate: English requests skip normalization, FAST
skips the business-context/pre-flight chain (reserved for HEAVY work), the
test spec is generated once per run (not per iteration), docs are generated
only when the request asks for them, and implementation prompts are grounded
in the *current contents* of the files the request refers to — the model
patches real code instead of hallucinating against a file-name list.

Latency is bounded, not best-effort: every LLM call has a per-call timeout
(`NRI_CALL_TIMEOUT_MS`, default 120s), SDK-internal retries are disabled so
retrying happens only in the harness's own logged layers (structured-output
repair loop: 2 attempts + a salvage pass by default, 1 attempt for large
structured calls like `proposal`, with failed responses kept as bounded
snippets instead of re-sent in full), and every node records its elapsed
time in the trace (`[timing] <node> Xs`) so slow stages stay attributable.

## Commands

Every subcommand works as `nri <cmd>`, `nri /<cmd>`, and as a slash command
inside `nri tui`.

| Command | What it does |
|---|---|
| `nri provider list/import/add/remove` | manage providers; auto-import from kimi-code/codex |
| `nri model list/assign/set/candidates` | per-node model routing by capability tier |
| `nri permission list/set-mode/allow/deny/clear` | execution policy: `plan` / `auto` / `yolo` + regex lists |
| `nri plan "<request>"` | read-only plan; stops before implement/test |
| `nri goal set/status/run/clear` | durable objective + completion criterion + budget; runs offer best-effort changes even when the criterion is missed |
| `nri swarm [--providers a,b] "<request>"` | same request across providers, side-by-side |
| `nri compact <state.json>` | fold run context into a dense summary |
| `nri graph-compact <state.json>` | same, plus deterministic graph-structure shrinking (free-text clipped; ids/edges preserved by construction) |
| `nri tui` | interactive console (ink TUI; readline fallback when piped) |
| `nri help` | CLI reference |

Key run flags: `-p/--provider`, `-m/--model`, `-c/--coverage`,
`--max-iterations`, `--locale <code>`, `--dump-state <path>`, `-y/--yes`
(auto-approve HITL), `--yolo` (apply changes without asking), `--ui`
(seoulism-themed live dashboard).

## Applying changes safely (y/n, yolo, refine loop)

After a run, nri analyzes the generated output for applicable changes and
offers to apply them to your working directory:

- **unified diff** → applied via `git apply --whitespace=fix`
- **full-file blocks** (```` ```ts // src/foo.ts ```` or bare `// path/file`
  sections) → written directly
- paths are sandboxed to the cwd (absolute/`..` rejected); overwritten files
  are backed up to `.nri-backup/<timestamp>/` first

Gating follows the permission mode: `auto` (default) shows a per-file summary
and asks `y/N`; `yolo` applies immediately (`--yolo` forces it per run and
implies HITL auto-approve); `plan` never applies. The same gate runs inside
`nri tui` as an in-console prompt.

### Anti-hallucination refine loop

Diffs, full-file overwrite blocks and JSON are exactly the formats LLMs
hallucinate most easily — so between AI output and application sits an
agentic mini-loop (`src/tools/refine.ts`):

1. **Deterministic flags first** (no LLM cost): phantom imports (package not
   in `package.json`, unresolvable relative paths — the classic
   `@granular/core`), overwrites that silently drop existing exports or
   shrink files, JSON that doesn't parse.
2. **Agentic correction** (only when flagged): the LLM reinterprets the
   output as ONE corrected unified diff against the *actual* file contents;
   the result is machine-validated (`git apply --check`, re-flagged) and
   retried with the rejection reason fed back (bounded iterations).
3. **Safety**: `yolo` refuses to apply output whose flags stay unresolved;
   `auto` shows the flags and leaves the decision to you.

Unit test: `npx tsx examples/refine-test.ts`

## Persistence & memory

Settings never evaporate: everything lives in OS-standard locations
(`src/store/paths.ts`):

| OS | Config | Data |
|---|---|---|
| Linux | `$XDG_CONFIG_HOME/nri` (`~/.config/nri`) | `$XDG_DATA_HOME/nri` (`~/.local/share/nri`) |
| macOS | `~/Library/Application Support/nri` | same |
| Windows | `%APPDATA%\nri` | `%LOCALAPPDATA%\nri` |

`NRI_CONFIG_HOME` / `NRI_DATA_HOME` override for tests or portable installs.

Every finished run is persisted automatically (request, path, coverage,
iterations, summary). Two memory generations are available:

- **Gen 1 — JSONL** (default): append-only `runs.jsonl`. Greppable,
  zero-dependency, keyword search.
- **Gen 2 — DB RAG**: SQLite (`node:sqlite`, no native deps) storing
  documents + embedding vectors. Retrieval is cosine similarity via OpenAI or
  Gemini embeddings, with a keyword fallback when no embedding key is set.
  (Note: `node:sqlite` currently prints an ExperimentalWarning on first use.)

```bash
nri memory backend rag        # switch generation (persisted in config)
nri memory ingest "<text>"    # add a note
nri memory search "<query>"   # retrieve relevant past runs/notes
nri memory stats              # backend + record counts
```

Unit test: `npx tsx examples/store-test.ts`

## Providers

| Provider | Implementation | Env key |
|---|---|---|
| OpenAI | `@langchain/openai` | `OPENAI_API_KEY` |
| Gemini | `@langchain/google-genai` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| Kimi (Moonshot) | OpenAI-compatible (no native JS SDK exists) | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| DeepSeek | `@langchain/deepseek` | `DEEPSEEK_API_KEY` |
| Grok (xAI) | `@langchain/xai` | `XAI_API_KEY` / `GROK_API_KEY` |
| Claude | `@langchain/anthropic` | `ANTHROPIC_API_KEY` |

`nri provider import kimi-code` pulls endpoint + model list + oauth token from
an existing kimi-code install; `nri model assign` lets you multi-select models
and maps them onto node tiers (strong: decompose/implement/pre_flight…, mid:
business_context/evaluate, fast: triage/fast_patch/test_writer). Config lives
in `~/.config/nri/config.json` merged with `nri.config.json` in the cwd.

## Examples

- `examples/smoke.ts` — full pipeline with a deterministic stub provider
  (no API keys): `npx tsx examples/smoke.ts`
- `examples/apply-test.ts` — apply-layer unit test (diff/file-block parsing,
  git apply, decline path, backups): `npx tsx examples/apply-test.ts`
- `examples/calculator-qt/` — a real PySide6 calculator generated end-to-end
  by nri (Gemini), including a mid-loop unary-minus fix driven by the
  coverage loop: `npx tsx examples/calculator-qt/run.ts gemini`
- `examples/self-refactor/` — nri refactoring its own evaluation node
  (dogfooding): the generated fix was reviewed and merged as-is

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run typecheck
npx tsx examples/smoke.ts
```

Layout: `src/providers/` (strategy pattern + factory + per-node resolver),
`src/graph/` (LangGraph nodes, edges, builder, compaction), `src/tools/`
(test runners, MCP, permissions, apply), `src/commands/` (CLI subcommands),
`src/ui/` (ink dashboard, console, shared REPL core, seoulism theme),
`src/state.ts` (Annotation state + zod schemas), `src/prompts.ts`.

## License

MIT
