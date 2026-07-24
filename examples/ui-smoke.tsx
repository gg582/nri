/** Render smoke test for the ink UI (no TTY needed beyond basic stdout). */
import React from "react";
import { render } from "ink";
import { App, type UiState } from "../src/ui/App.js";

const state: UiState = {
  provider: "stub",
  model: "stub-0",
  phase: "pre_flight",
  path: "HEAVY_PATH",
  trace: ["[triage] path=HEAVY_PATH", "[decompose] root=\"demo\"", "[pre-flight] valid=true"],
  coverage: 80,
  target: 80,
  iterations: 2,
  abstractGraph: {
    primal_nodes: [
      { id: "p1", responsibility: "parse request", member_task_ids: ["n1"], input_contract: "req", output_contract: "ast" },
      { id: "p2", responsibility: "emit code", member_task_ids: ["n2"], input_contract: "ast", output_contract: "code" },
    ],
    edges: [{ from: "p1", to: "p2" }],
    cycles_detected: [],
    linearization_notes: "linear",
  },
  awaitingApproval: false,
  done: true,
  exitCode: 0,
};

const ink = render(<App state={state} onApprove={() => {}} onReject={() => {}} />);
setTimeout(() => {
  ink.unmount();
  console.log("\nui render OK");
}, 300);
