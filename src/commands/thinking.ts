import { stdout } from "node:process";
import { loadConfig, saveGlobalConfig } from "../config.js";

/**
 * `/thinking show|hide` — toggle whether the pipeline's reasoning (node
 * trace, start lines, heartbeats) is streamed during runs. Persisted in
 * config; default is show.
 */
export function thinkingCommand(args: string[]): void {
  const [sub] = args;
  switch (sub) {
    case "show":
      saveGlobalConfig({ ui: { thinking: true } });
      stdout.write("thinking: shown — pipeline reasoning streams during runs.\n");
      return;
    case "hide":
      saveGlobalConfig({ ui: { thinking: false } });
      stdout.write("thinking: hidden — only results and warnings are shown.\n");
      return;
    case undefined: {
      const current = loadConfig().ui?.thinking ?? true;
      stdout.write(`thinking: ${current ? "shown (default)" : "hidden"} — /thinking show|hide\n`);
      return;
    }
    default:
      throw new Error(`unknown thinking subcommand "${sub}" (show|hide)`);
  }
}
