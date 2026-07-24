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

/** Assign selected models to node tiers by capability. */
export function assignByCapability(selected: Candidate[]): Record<string, string> {
  const pick = (tier: Tier): string | undefined =>
    selected.find((c) => c.tier === tier)?.spec;
  const strong = pick("strong") ?? pick("mid") ?? pick("fast");
  const mid = pick("mid") ?? pick("strong") ?? pick("fast");
  const fast = pick("fast") ?? pick("mid") ?? pick("strong");
  const nodes: Record<string, string> = {};
  for (const n of NODE_TIERS.strong) if (strong) nodes[n] = strong;
  for (const n of NODE_TIERS.mid) if (mid) nodes[n] = mid;
  for (const n of NODE_TIERS.fast) if (fast) nodes[n] = fast;
  return nodes;
}

/** Non-interactive assignment (used by the TUI wizard): apply and save. */
export function applyAssignment(pickedSpecs: string[]): { defaultSpec: string; nodes: Record<string, string> } {
  const all = getCandidates();
  const picked = pickedSpecs
    .map((spec) => all.find((c) => c.spec === spec) ?? { spec, tier: modelTier(spec.split(":")[1] ?? spec) });
  const nodes = assignByCapability(picked);
  const defaultSpec = picked.find((c) => c.tier === "strong")?.spec ?? picked[0].spec;
  const routing = loadConfig().routing ?? {};
  saveGlobalConfig({ routing: { ...routing, default: defaultSpec, nodes } });
  return { defaultSpec, nodes };
}

/* ---------------- subcommands ---------------- */

export function modelList(): void {
  const routing = loadConfig().routing ?? {};
  stdout.write(`default: ${routing.default ?? "(unset — uses --provider/NRI_PROVIDER)"}\n`);
  const all = [...NODE_TIERS.strong, ...NODE_TIERS.mid, ...NODE_TIERS.fast];
  for (const node of all) {
    const tier = NODE_TIERS.strong.includes(node) ? "strong" : NODE_TIERS.mid.includes(node) ? "mid" : "fast";
    stdout.write(`  ${node.padEnd(18)} [${tier.padEnd(6)}] ${routing.nodes?.[node] ?? "(default)"}\n`);
  }
}

export function modelSet(target?: string, spec?: string): void {
  if (!target || !spec) throw new Error('usage: nri model set <node|default> <provider:model>');
  parseModelSpec(spec); // validates provider name
  const routing = loadConfig().routing ?? {};
  if (target === "default") {
    saveGlobalConfig({ routing: { ...routing, default: spec } });
  } else {
    saveGlobalConfig({ routing: { ...routing, nodes: { ...routing.nodes, [target]: spec } } });
  }
  stdout.write(`routing: ${target} -> ${spec}\n`);
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
    const defaultSpec = picked.find((c) => c.tier === "strong")?.spec ?? picked[0].spec;
    stdout.write("\nproposed routing:\n");
    stdout.write(`  default -> ${defaultSpec}\n`);
    for (const [node, spec] of Object.entries(nodes)) stdout.write(`  ${node} -> ${spec}\n`);
    const ok = (await rl.question("\napply? [y/N] ")).trim().toLowerCase();
    if (ok !== "y") {
      stdout.write("aborted.\n");
      return;
    }
    const routing = loadConfig().routing ?? {};
    saveGlobalConfig({ routing: { ...routing, default: defaultSpec, nodes } });
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
      modelSet(rest[0], rest[1]);
      return;
    case "assign":
      await modelAssign();
      return;
    case "candidates": {
      for (const c of getCandidates()) stdout.write(`${c.spec} [${c.tier}]\n`);
      return;
    }
    default:
      throw new Error(`unknown model subcommand "${sub}" (list|set|assign|candidates)`);
  }
}

// re-export for help text
export { defaultModelFor };
