/**
 * Incremental file-block parser for streamed implementation output.
 *
 * The model streams one JSON document whose "code" string contains file
 * blocks (`// path/to/file.ext\n<content>` per file). This parser locates the
 * "code" string, decodes JSON escapes on the fly, and emits each file the
 * moment its block is complete (when the next path marker arrives, or the
 * string closes) — so files hit disk one by one during generation instead of
 * all at once at the end.
 */

import { FILE_MARKER_PATTERN } from "./apply.js";

export interface StreamedFile {
  path: string;
  content: string;
}

/** Same marker shape as apply.ts (single source: FILE_MARKER_PATTERN). */
const MARKER = new RegExp(`^(?:\\/\\/|#)\\s+(${FILE_MARKER_PATTERN})\\s*$`);

export class IncrementalFileParser {
  private phase: "find" | "code" | "done" = "find";
  private findBuffer = "";
  private escape = "";
  private line = "";
  private path: string | null = null;
  private body: string[] = [];

  /** Feed a raw text delta; returns files completed by this delta. */
  feed(delta: string): StreamedFile[] {
    const out: StreamedFile[] = [];
    if (this.phase === "done") return out;
    if (this.phase === "find") {
      this.findBuffer += delta;
      const m = this.findBuffer.match(/"code"\s*:\s*"/);
      if (!m) {
        this.findBuffer = this.findBuffer.slice(-16);
        return out;
      }
      delta = this.findBuffer.slice((m.index ?? 0) + m[0].length);
      this.phase = "code";
      this.findBuffer = "";
    }
    for (const ch of delta) this.consume(ch, out);
    return out;
  }

  /** Flush any pending block (truncated stream, or end of input). */
  finish(): StreamedFile[] {
    if (this.phase !== "code") return [];
    const out: StreamedFile[] = [];
    this.endLine(out);
    this.emitCurrent(out);
    this.phase = "done";
    return out;
  }

  private consume(ch: string, out: StreamedFile[]): void {
    if (this.escape) {
      this.escape += ch;
      let decoded: string | null = null;
      if (this.escape === "\\u") return; // expect 4 hex digits
      if (this.escape.startsWith("\\u")) {
        if (this.escape.length < 6) return;
        decoded = String.fromCharCode(Number.parseInt(this.escape.slice(2), 16));
      } else {
        const map: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\r": "\r", '\\"': '"', "\\\\": "\\", "\\/": "/" };
        decoded = map[this.escape] ?? this.escape.slice(1);
      }
      this.escape = "";
      // A decoded newline is a real line break, not literal text.
      if (decoded === "\n") this.endLine(out);
      else this.line += decoded;
      return;
    }
    if (ch === "\\") {
      this.escape = "\\";
      return;
    }
    if (ch === '"') {
      // closing quote of the "code" string — final block ends here
      this.endLine(out);
      this.emitCurrent(out);
      this.phase = "done";
      return;
    }
    if (ch === "\n") {
      this.endLine(out);
      return;
    }
    this.line += ch;
  }

  private endLine(out: StreamedFile[]): void {
    const marker = this.line.match(MARKER);
    if (marker) {
      this.emitCurrent(out);
      this.path = marker[1];
      this.body = [];
    } else if (this.path && !this.line.trim().startsWith("```")) {
      this.body.push(this.line);
    }
    this.line = "";
  }

  private emitCurrent(out: StreamedFile[]): void {
    if (this.path === null) return;
    const body = [...this.body];
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    out.push({ path: this.path, content: body.join("\n") + "\n" });
    this.path = null;
    this.body = [];
  }
}
