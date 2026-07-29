import { stdout } from "node:process";
import { loadConfig, saveGlobalConfig } from "../config.js";
import { normalizeReverseMode } from "../graph/direction.js";

/**
 * `/reverse on|off|auto` — graph reversal control.
 *   on:   always run the pipeline with every edge flipped (finalize first,
 *         normalize last) — top-down flows forced bottom-up and vice versa.
 *   off:  always run the normal order.
 *   auto: (default) static analysis of the request + project tree flips the
 *         graph only when one direction is overwhelmingly favorable — no
 *         LLM reasoning involved.
 * Persisted in config.
 */
export function reverseCommand(args: string[]): void {
  const [sub] = args;
  switch (sub) {
    case "on":
      saveGlobalConfig({ reverse: "on" });
      stdout.write("reverse: on — pipeline graph always runs fully reversed (top-down <-> bottom-up).\n");
      return;
    case "off":
      saveGlobalConfig({ reverse: "off" });
      stdout.write("reverse: off — normal pipeline order.\n");
      return;
    case "auto":
      saveGlobalConfig({ reverse: "auto" });
      stdout.write("reverse: auto — graph flips only when static analysis shows an overwhelming structural edge.\n");
      return;
    case undefined: {
      const current = normalizeReverseMode(loadConfig().reverse);
      stdout.write(`reverse: ${current}${current === "auto" ? " (default)" : ""} — /reverse on|off|auto\n`);
      return;
    }
    default:
      throw new Error(`unknown reverse subcommand "${sub}" (on|off|auto)`);
  }
}
