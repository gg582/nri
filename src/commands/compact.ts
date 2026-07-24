import { readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { compactState, graphCompactState } from "../graph/compact.js";
import { makeProviderResolver } from "../providers/resolver.js";
import type { AgentStateType } from "../state.js";

/**
 * /compact and /graph-compact — compress a dumped run-state JSON file.
 * usage: nri compact <state.json> [--out path]
 *        nri graph-compact <state.json> [--out path]
 * Produce state dumps with `nri run ... --dump-state state.json`.
 */
export async function compactCommand(args: string[], graphMode: boolean): Promise<void> {
  let input: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else input = args[i];
  }
  if (!input) {
    throw new Error(`usage: nri ${graphMode ? "graph-compact" : "compact"} <state.json> [--out path]`);
  }

  const state = JSON.parse(readFileSync(input, "utf8")) as AgentStateType;
  const provider = makeProviderResolver({})("evaluate");
  const update = graphMode ? await graphCompactState(state, provider) : await compactState(state, provider);
  const merged = { ...state, ...update };
  const target = out ?? input;
  writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");

  const beforeBytes = JSON.stringify(state).length;
  const afterBytes = JSON.stringify(merged).length;
  stdout.write(`${graphMode ? "graph-compact" : "compact"}: ${beforeBytes} -> ${afterBytes} bytes\n`);
  for (const line of (update.trace ?? []).filter((l) => l.includes("[warn]"))) stdout.write(`${line}\n`);
  stdout.write(`written -> ${target}\n`);
}
