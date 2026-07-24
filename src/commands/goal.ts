import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdout } from "node:process";
import { storePaths } from "../store/paths.js";
import { buildGraph, resumeNri, runNri } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";

const GOAL_PATH = storePaths().goalFile;

export interface GoalRecord {
  objective: string;
  completionCriterion?: string;
  budgetIterations?: number;
  createdAt: string;
  lastRun?: {
    at: string;
    coverage: number;
    target: number;
    iterations: number;
    met: boolean;
  };
}

function loadGoal(): GoalRecord | null {
  if (!existsSync(GOAL_PATH)) return null;
  try {
    return JSON.parse(readFileSync(GOAL_PATH, "utf8")) as GoalRecord;
  } catch {
    return null;
  }
}

function saveGoal(goal: GoalRecord): void {
  mkdirSync(dirname(GOAL_PATH), { recursive: true });
  writeFileSync(GOAL_PATH, JSON.stringify(goal, null, 2) + "\n");
}

function status(): void {
  const goal = loadGoal();
  if (!goal) {
    stdout.write("no active goal. Set one: nri goal set \"<objective>\"\n");
    return;
  }
  stdout.write(`objective:  ${goal.objective}\n`);
  if (goal.completionCriterion) stdout.write(`done when:  ${goal.completionCriterion}\n`);
  if (goal.budgetIterations) stdout.write(`budget:     ${goal.budgetIterations} iterations\n`);
  stdout.write(`created:    ${goal.createdAt}\n`);
  if (goal.lastRun) {
    const r = goal.lastRun;
    stdout.write(`last run:   ${r.at} — coverage ${r.coverage}%/${r.target}%, ${r.iterations} iterations, ${r.met ? "MET" : "not met"}\n`);
  }
}

async function run(): Promise<void> {
  const goal = loadGoal();
  if (!goal) throw new Error("no active goal — set one first: nri goal set \"<objective>\"");
  const request =
    goal.objective + (goal.completionCriterion ? `\n\nCompletion criterion: ${goal.completionCriterion}` : "");

  const graph = buildGraph({ resolveProvider: makeProviderResolver({}), testRunner: createTestRunner() });
  const threadId = `nri-goal-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  let runState = await runNri(graph, {
    request,
    targetTestCoverage: 80,
    maxIterations: goal.budgetIterations ?? 5,
    threadId,
  });
  for (let i = 0; i < 10 && runState.awaitingApproval; i++) {
    await resumeNri(graph, null, threadId);
    const snap = await graph.getState(config);
    runState = { finalState: snap.values as AgentStateType, awaitingApproval: snap.next.includes("human_approval") };
  }
  const s = runState.finalState;
  const met = s.currentTestCoverage >= s.targetTestCoverage;
  saveGoal({
    ...goal,
    lastRun: {
      at: new Date().toISOString(),
      coverage: s.currentTestCoverage,
      target: s.targetTestCoverage,
      iterations: s.iterationCount,
      met,
    },
  });
  for (const line of s.trace) stdout.write(`  ${line}\n`);
  stdout.write(met ? "\ngoal completion criterion MET.\n" : "\ngoal not yet met — see trace above.\n");
}

/** Entry point for `nri goal ...` / `nri /goal ...`. */
export async function goalCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "set": {
      const objective: string[] = [];
      let completionCriterion: string | undefined;
      let budgetIterations: number | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--done-when") completionCriterion = rest[++i];
        else if (rest[i] === "--budget") budgetIterations = Number(rest[++i]);
        else objective.push(rest[i]);
      }
      if (objective.length === 0) throw new Error('usage: nri goal set "<objective>" [--done-when "<criterion>"] [--budget N]');
      saveGoal({ objective: objective.join(" "), completionCriterion, budgetIterations, createdAt: new Date().toISOString() });
      stdout.write("goal set.\n");
      status();
      return;
    }
    case "status":
    case undefined:
      status();
      return;
    case "run":
      await run();
      return;
    case "clear":
      if (existsSync(GOAL_PATH)) writeFileSync(GOAL_PATH, "null\n");
      stdout.write("goal cleared.\n");
      return;
    default:
      throw new Error(`unknown goal subcommand "${sub}" (set|status|run|clear)`);
  }
}
