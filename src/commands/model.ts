import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, saveGlobalConfig } from "../config.js";
import {
  availableProviders,
  defaultModelFor,
  modelsForProvider,
  parseModelSpec,
} from "../providers/factory.js";

/** Pipeline nodes that make LLM calls, grouped by required capability. */
export const NODE_TIERS: Record<"strong" | "mid" | "fast", string[]> = {
  strong: ["decompose", "abstract_graph", "proposal", "implement", "pre_flight"],
  mid: ["business_context", "evaluate"],
  fast: ["triage", "fast_patch", "test_writer"],
};

type Tier = keyof typeof NODE_TIERS;

/** Rough capability/performance heuristic from the model id. */
export function modelTier(model: string): Tier {
  if (/flash|haiku|mini|nano|lite|highspeed|fast|turbo/i.test(model)) return "fast";
  if (/pro|opus|reasoner|^o\d|gpt-5|grok-4|k3|k2|sonnet|254k/i.test(model)) return "strong";
  return "mid";
}

interface Candidate {
  spec: string; // "provider:model"
  tier: Tier;
}

export function getCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const provider of availableProviders()) {
    for (const model of modelsForProvider(provider)) {
      out.push({ spec: `${provider}:${model}`, tier: modelTier(model) });
    }
  }
  return out;
}

/**
 * Assign selected models to node tiers by capability. Each node gets an
 * ordered trial pool: its own tier first, then the other tiers — routing
 * trials stay within the checked models only.
 */
export function assignByCapability(selected: Candidate[]): Record<string, string[]> {
  const pool = (tier: Tier): string[] => selected.filter((c) => c.tier === tier).map((c) => c.spec);
  const chain = (...tiers: Tier[]): string[] => [...new Set(tiers.flatMap(pool))];
  const strong = chain("strong", "mid", "fast");
  const mid = chain("mid", "strong", "fast");
  const fast = chain("fast", "mid", "strong");
  const nodes: Record<string, string[]> = {};
  for (const n of NODE_TIERS.strong) if (strong.length) nodes[n] = strong;
  for (const n of NODE_TIERS.mid) if (mid.length) nodes[n] = mid;
  for (const n of NODE_TIERS.fast) if (fast.length) nodes[n] = fast;
  return nodes;
}

/** Default trial pool: strongest tier first, selection order within a tier. */
function defaultPool(selected: Candidate[]): string[] {
  const tiers: Tier[] = ["strong", "mid", "fast"];
  return [...new Set(tiers.flatMap((t) => selected.filter((c) => c.tier === t).map((c) => c.spec)))];
}

/** Render a routing value (single spec or trial pool) for display. */
export function formatSpec(value?: string | string[]): string | undefined {
  return value && (Array.isArray(value) ? value.join(" → ") : value);
}

/** Non-interactive assignment (used by the TUI wizard): apply and save. */
export function applyAssignment(pickedSpecs: string[]): { defaultSpec: string[]; nodes: Record<string, string[]> } {
  const all = getCandidates();
  const picked = pickedSpecs
    .map((spec) => all.find((c) => c.spec === spec) ?? { spec, tier: modelTier(spec.split(":")[1] ?? spec) });
  const nodes = assignByCapability(picked);
  const defaultSpec = defaultPool(picked);
  const routing = loadConfig().routing ?? {};
  saveGlobalConfig({ routing: { ...routing, default: defaultSpec, nodes } });
  return { defaultSpec, nodes };
}

/* ---------------- subcommands ---------------- */

export function modelList(): void {
  const routing = loadConfig().routing ?? {};
  stdout.write(`default: ${formatSpec(routing.default) ?? "(unset — uses --provider/NRI_PROVIDER)"}\n`);
  const all = [...NODE_TIERS.strong, ...NODE_TIERS.mid, ...NODE_TIERS.fast];
  for (const node of all) {
    const tier = NODE_TIERS.strong.includes(node) ? "strong" : NODE_TIERS.mid.includes(node) ? "mid" : "fast";
    stdout.write(`  ${node.padEnd(18)} [${tier.padEnd(6)}] ${formatSpec(routing.nodes?.[node]) ?? "(default)"}\n`);
  }
}

export function modelSet(target?: string, specs: string[] = []): void {
  if (!target || specs.length === 0)
    throw new Error("usage: nri model set <node|default> <provider:model> [more models...]");
  const available = new Set(availableProviders());
  for (const spec of specs) {
    const { provider } = parseModelSpec(spec); // validates provider names
    if (!available.has(provider))
      stdout.write(`warning: provider "${provider}" has no credentials — it will fail and fall back.\n`);
  }
  const value: string | string[] = specs.length === 1 ? specs[0] : specs;
  const routing = loadConfig().routing ?? {};
  if (target === "default") {
    saveGlobalConfig({ routing: { ...routing, default: value } });
  } else {
    saveGlobalConfig({ routing: { ...routing, nodes: { ...routing.nodes, [target]: value } } });
  }
  stdout.write(`routing: ${target} -> ${formatSpec(value)}\n`);
}

/** Current ordered trial pool for a routing target ("default" or a node name). */
export function modelOrder(target = "default"): string[] {
  const routing = loadConfig().routing ?? {};
  const value = target === "default" ? routing.default : routing.nodes?.[target];
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

/** Persist a reordered pool (same specs, new order). */
export function modelReorderSave(target: string, specs: string[]): void {
  const value: string | string[] = specs.length === 1 ? specs[0] : specs;
  const routing = loadConfig().routing ?? {};
  if (target === "default") {
    saveGlobalConfig({ routing: { ...routing, default: value } });
  } else {
    saveGlobalConfig({ routing: { ...routing, nodes: { ...routing.nodes, [target]: value } } });
  }
  stdout.write(`routing: ${target} -> ${formatSpec(value)}\n`);
}

/** Parse "2 1 3" into a reordered spec array; null unless an exact permutation. */
export function parsePermutation(answer: string, specs: string[]): string[] | null {
  const idx = answer.split(/[\s,]+/).filter(Boolean).map((s) => Number(s) - 1);
  if (idx.length !== specs.length) return null;
  if ([...idx].sort((a, b) => a - b).some((v, i) => v !== i)) return null;
  return idx.map((i) => specs[i]);
}

/** Interactive reorder (CLI): show the pool, take a permutation like "2 1 3". */
export async function modelReorder(target = "default"): Promise<void> {
  const specs = modelOrder(target);
  if (specs.length === 0) {
    stdout.write(`no pool configured for "${target}" — use \`nri model set\` or \`nri model assign\` first.\n`);
    return;
  }
  stdout.write(`current fallback order for ${target}:\n`);
  specs.forEach((s, i) => stdout.write(`  ${i + 1}. ${s}\n`));
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("new order (e.g. 2 1 3): ");
    const next = parsePermutation(answer, specs);
    if (!next) {
      stdout.write("invalid permutation — aborted.\n");
      return;
    }
    modelReorderSave(target, next);
  } finally {
    rl.close();
  }
}

export async function modelAssign(): Promise<void> {
  const all = getCandidates();
  if (all.length === 0) {
    stdout.write("no providers available — run `nri provider import` or `nri provider add` first.\n");
    return;
  }
  stdout.write("available models (select multiple, e.g. \"1,3,4\"):\n");
  all.forEach((c, i) => stdout.write(`  ${i + 1}. ${c.spec}  [${c.tier}]\n`));

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("selection: ");
    const picked = [...new Set(answer.split(/[\s,]+/).filter(Boolean).map((s) => Number(s) - 1))]
      .map((i) => all[i])
      .filter(Boolean);
    if (picked.length === 0) {
      stdout.write("nothing selected.\n");
      return;
    }
    const nodes = assignByCapability(picked);
    const defPool = defaultPool(picked);
    stdout.write("\nproposed routing (→ = trial order, fallback on failure):\n");
    stdout.write(`  default -> ${defPool.join(" → ")}\n`);
    for (const [node, spec] of Object.entries(nodes)) stdout.write(`  ${node} -> ${spec.join(" → ")}\n`);
    const ok = (await rl.question("\napply? [y/N] ")).trim().toLowerCase();
    if (ok !== "y") {
      stdout.write("aborted.\n");
      return;
    }
    const routing = loadConfig().routing ?? {};
    saveGlobalConfig({ routing: { ...routing, default: defPool, nodes } });
    stdout.write("saved.\n");
  } finally {
    rl.close();
  }
}

/** Entry point for `nri model ...` / `nri /model ...`. */
export async function modelCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined:
      modelList();
      return;
    case "set":
      modelSet(rest[0], rest.slice(1));
      return;
    case "assign":
      await modelAssign();
      return;
    case "reorder":
    case "order":
      await modelReorder(rest[0]);
      return;
    case "candidates": {
      for (const c of getCandidates()) stdout.write(`${c.spec} [${c.tier}]\n`);
      return;
    }
    default:
      throw new Error(`unknown model subcommand "${sub}" (list|set|assign|reorder|candidates)`);
  }
}

// re-export for help text
export { defaultModelFor };
