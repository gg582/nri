import { existsSync, readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import type { ApplyPlan } from "./apply.js";
import { extractImports } from "./hallucination.js";

export interface ChangeMeshNode {
  id: string;
  path: string;
  language: string;
  operation: "modify" | "create";
  polarity: "plus" | "minus" | "mixed" | "neutral";
  plusWeight: number;
  minusWeight: number;
  addedLines: string[];
  removedLines: string[];
}

export interface ChangeMesh {
  nodes: ChangeMeshNode[];
  edges: Array<{ from: string; to: string; relation: "imports" | "relocates" }>;
  stages: string[][];
}

export interface ChangeInterpretation {
  plusWeight: number;
  minusWeight: number;
  maxDistance: number;
  clusters: string[][];
  kind: "addition" | "removal" | "relocation" | "separation" | "mixed";
}

function language(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return (({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp", h: "cpp", hpp: "cpp" } as Record<string, string>)[ext] ?? ext) || "text";
}

const meaningfulLines = (content: string): string[] => content.split("\n").map((line) => line.trim()).filter(Boolean);

function lineDelta(path: string, content: string, kind: "diff" | "full-file"): { added: string[]; removed: string[] } {
  if (kind === "diff") {
    return {
      added: content.split("\n").filter((line) => /^\+[^+]/.test(line)).map((line) => line.slice(1).trim()).filter(Boolean),
      removed: content.split("\n").filter((line) => /^-[^-]/.test(line)).map((line) => line.slice(1).trim()).filter(Boolean),
    };
  }
  const next = meaningfulLines(content);
  if (!existsSync(path)) return { added: next, removed: [] };
  const previous = meaningfulLines(readFileSync(path, "utf8"));
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return { added: next.filter((line) => !previousSet.has(line)), removed: previous.filter((line) => !nextSet.has(line)) };
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const common = b.filter((line) => left.has(line)).length;
  return common / Math.max(1, Math.min(left.size, new Set(b).size));
}

/**
 * Decompose a generated change into language-aware file nodes, then compress
 * independent nodes into executable stages. There is intentionally no line or
 * file-count limit: a large, coherent file remains one verified node.
 */
export function buildChangeMesh(plan: ApplyPlan): ChangeMesh {
  const nodes = plan.changes.map((change, index) => {
    const delta = lineDelta(change.path, change.content, change.kind);
    return {
      id: `change-${index + 1}`,
      path: change.path,
      language: language(change.path),
      operation: existsSync(change.path) ? "modify" : "create",
      polarity: delta.added.length && delta.removed.length ? "mixed" : delta.added.length ? "plus" : delta.removed.length ? "minus" : "neutral",
      plusWeight: delta.added.length,
      minusWeight: delta.removed.length,
      addedLines: delta.added,
      removedLines: delta.removed,
    } satisfies ChangeMeshNode;
  });
  const byName = new Map(nodes.map((node) => [basename(node.path, extname(node.path)), node]));
  const edges: ChangeMesh["edges"] = [];
  plan.changes.forEach((change, index) => {
    for (const specifier of extractImports(change.content)) {
      const target = byName.get(basename(specifier).replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/i, ""));
      if (target && target.id !== nodes[index].id) edges.push({ from: nodes[index].id, to: target.id, relation: "imports" });
    }
  });
  for (const source of nodes) {
    for (const target of nodes) {
      if (source.id !== target.id && overlap(source.removedLines, target.addedLines) >= 0.7) {
        edges.push({ from: source.id, to: target.id, relation: "relocates" });
      }
    }
  }
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const stages = [nodes.filter((node) => !linked.has(node.id)).map((node) => node.id), ...edges.map((edge) => [edge.from, edge.to])]
    .filter((stage) => stage.length > 0);
  return { nodes, edges, stages };
}

export function summarizeChangeMesh(mesh: ChangeMesh): string[] {
  return [
    `change mesh: ${mesh.nodes.length} language-aware node(s), ${mesh.stages.length} compressed stage(s)`,
    ...mesh.nodes.map((node) => `  [${node.polarity} +${node.plusWeight}/-${node.minusWeight}] [${node.language}] ${node.path}`),
  ];
}

/** Interpret positive/negative change mass and topology without applying an
 * arbitrary size cap. This distinguishes a genuine relocation from deletion,
 * and a modular split from unrelated churn. */
export function interpretChangeMesh(mesh: ChangeMesh): ChangeInterpretation {
  const plusWeight = mesh.nodes.reduce((total, node) => total + node.plusWeight, 0);
  const minusWeight = mesh.nodes.reduce((total, node) => total + node.minusWeight, 0);
  const adjacency = new Map(mesh.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of mesh.edges) { adjacency.get(edge.from)?.add(edge.to); adjacency.get(edge.to)?.add(edge.from); }
  const clusters: string[][] = [];
  const seen = new Set<string>();
  for (const node of mesh.nodes) {
    if (seen.has(node.id)) continue;
    const cluster: string[] = []; const queue = [node.id]; seen.add(node.id);
    while (queue.length) { const current = queue.shift()!; cluster.push(current); for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
    clusters.push(cluster);
  }
  const maxDistance = clusters.reduce((max, cluster) => Math.max(max, Math.max(0, cluster.length - 1)), 0);
  const hasRelocation = mesh.edges.some((edge) => edge.relation === "relocates");
  const kind = hasRelocation ? "relocation" : clusters.length > 1 && mesh.nodes.length > 1 ? "separation" : plusWeight && !minusWeight ? "addition" : minusWeight && !plusWeight ? "removal" : "mixed";
  return { plusWeight, minusWeight, maxDistance, clusters, kind };
}
