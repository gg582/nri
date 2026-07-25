/**
 * Best-effort deterministic repair of malformed/truncated JSON — the most
 * common LLM output failure is a cut-off string ("Unterminated string at
 * position N") when a long code blob hits the output limit. Repairs, in
 * order: strip trailing commas, close an unterminated string, then close
 * unclosed brackets in reverse order. The result may still be invalid (or
 * schema-incomplete); it is a cheap pre-flight before burning model calls.
 */
export function repairJson(input: string): string {
  let s = input;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (escaped) s = s.slice(0, -1); // dangling backslash at the cut point
  if (inString) s += '"';
  while (stack.length > 0) s += stack.pop();
  // Strip trailing commas LAST — closing brackets can land after a comma.
  return s.replace(/,(\s*[}\]])/g, "$1");
}
