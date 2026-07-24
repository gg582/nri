import React from "react";
import { Box, Text, useInput } from "ink";
import type { AbstractGraph } from "../state.js";
import { depthColor, theme } from "./theme.js";

export interface UiState {
  provider: string;
  model: string;
  phase: string;
  path: string;
  trace: string[];
  coverage: number;
  target: number;
  iterations: number;
  abstractGraph: AbstractGraph | null;
  awaitingApproval: boolean;
  done: boolean;
  exitCode: number;
}

/** Compute per-node depth (topological level) from abstract-graph edges. */
export function computeDepths(graph: AbstractGraph): Map<string, number> {
  const ids = graph.primal_nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) incoming.get(e.to)?.push(e.from);
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard (should be linearized already)
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map((p) => visit(p, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) visit(id, new Set());
  return depth;
}

function Header({ provider, model }: { provider: string; model: string }) {
  return (
    <Box borderStyle="round" borderColor={theme.control} paddingX={1} justifyContent="space-between">
      <Text bold color={theme.control}>
        nri
      </Text>
      <Text color={theme.info}>
        {provider}/{model}
      </Text>
    </Box>
  );
}

function PathBadge({ path }: { path: string }) {
  if (!path) return <Text color={theme.dim}>routing…</Text>;
  const color = path === "FAST_PATH" ? theme.success : theme.value;
  return (
    <Text>
      <Text color={theme.dim}>path: </Text>
      <Text bold color={color}>
        {path}
      </Text>
    </Text>
  );
}

function CoverageBar({ coverage, target }: { coverage: number; target: number }) {
  const width = 30;
  const filled = Math.round((Math.min(coverage, 100) / 100) * width);
  const ok = coverage >= target;
  return (
    <Text>
      <Text color={theme.dim}>coverage </Text>
      <Text color={ok ? theme.success : theme.value}>{"█".repeat(filled)}</Text>
      <Text color={theme.dim}>{"░".repeat(width - filled)}</Text>
      <Text color={ok ? theme.success : theme.value}> {coverage.toFixed(0)}%</Text>
      <Text color={theme.dim}> / target {target}%</Text>
    </Text>
  );
}

function GraphView({ graph }: { graph: AbstractGraph }) {
  const depths = computeDepths(graph);
  const maxDepth = Math.max(0, ...depths.values());
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.dim} paddingX={1}>
      <Text color={theme.structure} bold>
        abstract graph ({graph.primal_nodes.length} primal nodes, {graph.edges.length} edges)
      </Text>
      {graph.primal_nodes.map((n) => {
        const d = depths.get(n.id) ?? 0;
        const t = maxDepth === 0 ? 0 : d / maxDepth;
        return (
          <Text key={n.id}>
            <Text color={theme.dim}>{"  ".repeat(d)}├─ </Text>
            <Text bold color={depthColor(t)}>
              {n.id}
            </Text>
            <Text color={theme.text}> {n.responsibility}</Text>
            <Text color={theme.dim}> [depth {d}]</Text>
          </Text>
        );
      })}
      {graph.edges.map((e, i) => (
        <Text key={`e${i}`} color={theme.control}>
          {"  "}
          {e.from} → {e.to}
        </Text>
      ))}
      {graph.cycles_detected.length > 0 && (
        <Text color={theme.error}>cycles linearized: {graph.cycles_detected.join(", ")}</Text>
      )}
    </Box>
  );
}

function TraceLog({ trace }: { trace: string[] }) {
  const visible = trace.slice(-8);
  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((line, i) => (
        <Text key={`${i}-${line}`} color={theme.trace} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function App({
  state,
  onApprove,
  onReject,
}: {
  state: UiState;
  onApprove: () => void;
  onReject: () => void;
}) {
  useInput(
    (input) => {
      if (!state.awaitingApproval) return;
      if (input.toLowerCase() === "y") onApprove();
      if (input.toLowerCase() === "n") onReject();
    },
    { isActive: state.awaitingApproval },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header provider={state.provider} model={state.model} />
      <Box marginTop={1} gap={2}>
        <PathBadge path={state.path} />
        <Text color={theme.dim}>phase: </Text>
        <Text color={theme.accent}>{state.phase || "starting"}</Text>
        <Text color={theme.dim}>iter: </Text>
        <Text color={theme.value}>{state.iterations}</Text>
      </Box>
      <Box marginTop={1}>
        <CoverageBar coverage={state.coverage} target={state.target} />
      </Box>
      {state.abstractGraph && (
        <Box marginTop={1}>
          <GraphView graph={state.abstractGraph} />
        </Box>
      )}
      <TraceLog trace={state.trace} />
      {state.awaitingApproval && (
        <Box marginTop={1} borderStyle="double" borderColor={theme.prompt} paddingX={1}>
          <Text bold color={theme.prompt}>
            HITL: approve proposal graph and continue? [y/n]
          </Text>
        </Box>
      )}
      {state.done && (
        <Box marginTop={1}>
          <Text bold color={state.exitCode === 0 ? theme.success : theme.error}>
            {state.exitCode === 0
              ? `✔ done — coverage target met (${state.coverage}%)`
              : `✘ stopped — coverage ${state.coverage}% < target ${state.target}%`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
