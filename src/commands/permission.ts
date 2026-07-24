import { stdout } from "node:process";
import { loadConfig, saveGlobalConfig } from "../config.js";
import type { PermissionMode } from "../tools/permissions.js";

const MODES: PermissionMode[] = ["plan", "auto", "yolo"];

function list(): void {
  const perms = loadConfig().permissions ?? {};
  stdout.write(`mode:  ${perms.mode ?? "auto (default)"}\n`);
  stdout.write(`allow: ${(perms.allow ?? []).join(", ") || "(none)"}\n`);
  stdout.write(`deny:  ${(perms.deny ?? []).join(", ") || "(none)"}\n`);
  stdout.write("\nmodes: plan = execute nothing | auto = block destructive+deny-listed | yolo = allow all\n");
}

export async function permissionCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const perms = loadConfig().permissions ?? {};
  switch (sub) {
    case "list":
    case undefined:
      list();
      return;
    case "set-mode": {
      const mode = rest[0] as PermissionMode;
      if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}`);
      saveGlobalConfig({ permissions: { ...perms, mode } });
      stdout.write(`permission mode -> ${mode}\n`);
      return;
    }
    case "allow":
    case "deny": {
      const pattern = rest.join(" ");
      if (!pattern) throw new Error(`usage: nri permission ${sub} <regex>`);
      new RegExp(pattern); // validate
      const key = sub as "allow" | "deny";
      saveGlobalConfig({ permissions: { ...perms, [key]: [...(perms[key] ?? []), pattern] } });
      stdout.write(`${key} list += /${pattern}/\n`);
      return;
    }
    case "clear": {
      const key = rest[0] as "allow" | "deny";
      if (key !== "allow" && key !== "deny") throw new Error("usage: nri permission clear <allow|deny>");
      saveGlobalConfig({ permissions: { ...perms, [key]: [] } });
      stdout.write(`${key} list cleared\n`);
      return;
    }
    default:
      throw new Error(`unknown permission subcommand "${sub}" (list|set-mode|allow|deny|clear)`);
  }
}
