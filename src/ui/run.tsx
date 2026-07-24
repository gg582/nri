import React from "react";
import { render } from "ink";
import { buildGraph } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";
import { App, type UiState } from "./App.js";

export interface UiRunOptions {
  provider?: string;
  model?: string;
  request: string;
  coverage: number;
  maxIterations: number;
}

/**
 * Drive the nri pipeline with the ink TUI.
 * Streams node-level updates out of LangGraph into the UI, pauses at the
 * HITL breakpoint until the user approves (y) or rejects (n).
 * Returns the process exit code: 0 = coverage target met, 2 = rejected, 3 = missed.
 */
export async function runWithUi(opts: UiRunOptions): Promise<number> {
  const resolver = makeProviderResolver({ provider: opts.provider, model: opts.model });
  const head = resolver("triage");
  const graph = buildGraph({ resolveProvider: resolver, testRunner: createTestRunner() });
  const threadId = `nri-ui-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const state: UiState = {
    provider: head.name,
    model: head.model,
    phase: "",
    path: "",
    trace: [],
    coverage: 0,
    target: opts.coverage,
    iterations: 0,
    abstractGraph: null,
    awaitingApproval: false,
    done: false,
    exitCode: 0,
  };

  let approvalResolve: ((approved: boolean) => void) | null = null;
  const ink = render(
    <App
      state={state}
      onApprove={() => approvalResolve?.(true)}
      onReject={() => approvalResolve?.(false)}
    />,
  );
  const rerender = () =>
    ink.rerender(
      <App
        state={{ ...state }}
        onApprove={() => approvalResolve?.(true)}
        onReject={() => approvalResolve?.(false)}
      />,
    );

  const drive = async (input: Record<string, unknown> | null) => {
    const stream = await graph.stream(input as never, { ...config, streamMode: "updates" });
    for await (const chunk of stream) {
      for (const [node, update] of Object.entries(chunk)) {
        state.phase = node;
        const u = update as Partial<AgentStateType> | undefined;
        if (!u) continue;
        if (Array.isArray(u.trace)) state.trace = [...state.trace, ...u.trace];
        if (u.selectedPath) state.path = u.selectedPath;
        if (typeof u.currentTestCoverage === "number") state.coverage = u.currentTestCoverage;
        if (typeof u.iterationCount === "number") state.iterations = u.iterationCount;
        if (u.abstractGraph) state.abstractGraph = u.abstractGraph;
        rerender();
      }
    }
  };

  await drive({
    originalRequest: opts.request,
    currentRequest: opts.request,
    targetTestCoverage: opts.coverage,
    maxIterations: opts.maxIterations,
  });

  let final = (await graph.getState(config)).values as AgentStateType;
  let exitCode = 0;

  // HITL loop: every heavy-path iteration pauses at human_approval.
  for (let guard = 0; guard < 10; guard++) {
    const snap = await graph.getState(config);
    if (!snap.next.includes("human_approval")) break;
    state.awaitingApproval = true;
    rerender();
    const approved = await new Promise<boolean>((resolve) => {
      approvalResolve = resolve;
    });
    approvalResolve = null;
    state.awaitingApproval = false;
    rerender();
    if (!approved) {
      exitCode = 2;
      break;
    }
    await drive(null);
    final = (await graph.getState(config)).values as AgentStateType;
  }

  if (exitCode === 0) {
    exitCode = final.currentTestCoverage >= final.targetTestCoverage ? 0 : 3;
  }
  state.coverage = final.currentTestCoverage;
  state.done = true;
  state.exitCode = exitCode;
  rerender();

  // Leave the final frame on screen briefly, then print the artifact plainly.
  await new Promise((r) => setTimeout(r, 400));
  ink.unmount();
  if (final.generatedCode) {
    process.stdout.write("\n=== generated code ===\n" + final.generatedCode + "\n");
  }
  return exitCode;
}
