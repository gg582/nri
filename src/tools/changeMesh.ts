import { existsSync } from "node:fs";
import { extname, basename } from "node:path";
import type { ApplyPlan } from "./apply.js";
import { extractImports } from "./hallucination.js";

export interface ChangeMeshNode {
  id: string;
  path: string;
  language: string;
  operation: "modify" | "create";
}

export interface ChangeMesh {
  nodes: ChangeMeshNode[];
  edges: Array<{ from: string; to: string; relation: "imports" | "same-module" }>;
  stages: string[][];
}

function language(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return (({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp", h: "cpp", hpp: "cpp" } as Record<string, string>)[ext] ?? ext) || "text";
}

/**
 * Decompose a generated change into language-aware file nodes, then compress
 * independent nodes into executable stages. There is intentionally no line or
 * file-count limit: a large, coherent file remains one verified node.
 */
export function buildChangeMesh(plan: ApplyPlan): ChangeMesh {
  const nodes = plan.changes.map((change, index) => ({
    id: `change-${index + 1}`,
    path: change.path,
    language: language(change.path),
    operation: existsSync(change.path) ? "modify" : "create",
  } satisfies ChangeMeshNode));
  const byName = new Map(nodes.map((node) => [basename(node.path, extname(node.path)), node]));
  const edges: ChangeMesh["edges"] = [];
  plan.changes.forEach((change, index) => {
    for (const specifier of extractImports(change.content)) {
      const target = byName.get(basename(specifier).replace(/\.(?:[cm]?[jt]sx?|py|go|rs)$/i, ""));
      if (target && target.id !== nodes[index].id) edges.push({ from: nodes[index].id, to: target.id, relation: "imports" });
    }
  });
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const stages = [nodes.filter((node) => !linked.has(node.id)).map((node) => node.id), ...edges.map((edge) => [edge.from, edge.to])]
    .filter((stage) => stage.length > 0);
  return { nodes, edges, stages };
}

export function summarizeChangeMesh(mesh: ChangeMesh): string[] {
  return [
    `change mesh: ${mesh.nodes.length} language-aware node(s), ${mesh.stages.length} compressed stage(s)`,
    ...mesh.nodes.map((node) => `  [${node.language}] ${node.path}`),
  ];
}
