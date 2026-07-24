import { loadConfig } from "../config.js";

export type PermissionMode = "plan" | "auto" | "yolo";

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

/** Patterns that are destructive or outward-facing by default. */
const DEFAULT_DENY = [/\brm\s+-rf?\b/, /\bgit\s+push\b/, /\bsudo\b/, /:\(\)\s*\{/, /\bmkfs\b/, /\bdd\s+if=/];

/**
 * Gate a shell command or tool call against the configured permission policy.
 *
 * Modes:
 *   plan — execute nothing (read-only planning).
 *   auto — allow, except deny-listed and known-destructive patterns.
 *   yolo — allow everything (deny list still advisory-logged).
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
  if (deny.some((re) => re.test(command))) {
    return { allowed: false, reason: `deny-listed by user pattern: ${command}` };
  }
  if (mode === "auto" && DEFAULT_DENY.some((re) => re.test(command))) {
    return { allowed: false, reason: `blocked destructive pattern in auto mode: ${command}` };
  }
  return { allowed: true, reason: `mode=${mode}` };
}
