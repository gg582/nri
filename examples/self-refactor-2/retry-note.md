
=== RETRY WITH REFINEMENT (previous attempt FAILED evaluation) ===
Synthesis question from the pipeline's own evaluation of the previous attempt:
"The implementation significantly alters or removes existing core components (AgentState schema, NodeDeps interface, buildGraph structure, runNri signature, loadConfig logic, cli.ts features) instead of extending them. How can the new features be integrated while preserving all existing functionality and adhering strictly to the constraint 'Keep every existing node, exported name, and schema otherwise unchanged'?"

Hard requirements for this attempt:
1. Output a UNIFIED DIFF (---/+++ headers, @@ hunks with real context lines copied from the embedded files). NO annotated full files, NO pseudo-code, NO prose outside the diff.
2. AgentState is an Annotation.Root(...) — extend it, never redefine it as an interface. `replace` is a local helper in state.ts, not an import.
3. src/config.ts already exports NriConfig { locale?, providers?, routing?, permissions? }, loadConfig(), saveGlobalConfig() — only ADD resolveLocale().
4. buildGraph already takes (deps: GraphDeps, opts?: BuildGraphOptions) with GraphDeps { resolveProvider, testRunner }. Node factories receive NodeDeps { provider, testRunner } via forNode() — follow that exact pattern for normalize/finalize.
5. Every import path must match the embedded files exactly.
