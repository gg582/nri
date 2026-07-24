import { loadConfig } from "../config.js";

export type PermissionMode = "plan" | "auto" | "yolo";

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  /** Non-blocking notice — e.g. yolo mode running a deny-listed command. */
  advisory?: string;
}

/** Patterns that are destructive or outward-facing by default. */
const DEFAULT_DENY = [/\brm\s+-rf?\b/, /\bgit\s+push\b/, /\bsudo\b/, /:\(\)\s*\{/, /\bmkfs\b/, /\bdd\s+if=/];

/**
 * Gate a shell command or tool call against the configured permission policy.
 *
 * Modes:
 *   plan — execute nothing (read-only planning).
 *   auto — allow, except deny-listed and known-destructive patterns.
 *   yolo — allow everything; deny-listed/destructive matches still run, but
 *          the decision carries an `advisory` the caller should surface.
 *
 * Config: permissions: { mode, allow: string[], deny: string[] } — allow/deny
 * entries are regex strings matched against the command.
 */
export function checkPermission(command: string): PermissionDecision {
  const perms = loadConfig().permissions;
  const mode: PermissionMode = perms?.mode ?? "auto";

  if (mode === "plan") {
    return { allowed: false, reason: `plan mode: execution disabled ("${command}")` };
  }

  const allow = (perms?.allow ?? []).map((p) => new RegExp(p));
  const deny = (perms?.deny ?? []).map((p) => new RegExp(p));

  if (allow.some((re) => re.test(command))) return { allowed: true, reason: "allow-listed" };

  const denied = deny.some((re) => re.test(command));
  const destructive = DEFAULT_DENY.some((re) => re.test(command));

  if (mode === "yolo") {
    return {
      allowed: true,
      reason: "mode=yolo",
      ...(denied || destructive
        ? {
            advisory: `yolo advisory: ${denied ? "deny-listed" : "known-destructive"} command executed: ${command}`,
          }
        : {}),
    };
  }
  if (denied) return { allowed: false, reason: `deny-listed by user pattern: ${command}` };
  if (destructive) return { allowed: false, reason: `blocked destructive pattern in auto mode: ${command}` };
  return { allowed: true, reason: `mode=${mode}` };
}
