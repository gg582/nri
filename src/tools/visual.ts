import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { planApply } from "./apply.js";
import { checkPermission } from "./permissions.js";

const execAsync = promisify(exec);

/* ---------------- temp file lifecycle: deleted on session exit ---------------- */

const tempDirs = new Set<string>();

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nri-visual-"));
  tempDirs.add(dir);
  return dir;
}

/** Delete every visual-check temp dir (called on session exit). */
export async function cleanupVisualTemps(): Promise<void> {
  for (const dir of [...tempDirs]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    tempDirs.delete(dir);
  }
}

// Hard backstop: also clean on process exit (sync).
process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/* ---------------- target detection ---------------- */

export type VisualTarget = { kind: "web"; entry: string } | { kind: "gui" };

/** Decide whether the generated project has a visual surface worth checking. */
export function detectVisualTarget(code: string, request: string): VisualTarget | null {
  const plan = planApply(code);
  const paths = plan.changes.map((c) => c.path);
  let html = paths.find((p) => p.endsWith("index.html")) ?? paths.find((p) => p.endsWith(".html"));
  if (!html) {
    const match = code.match(/^(?:\/\/|#)\s*([\w.-]+\.html?)\s*$/m);
    if (match) html = match[1];
  }
  if (html) return { kind: "web", entry: html };
  const guiCode = /QApplication|QWidget|QMainWindow|Gtk\.new|gtk_main|tkinter|QtWidgets|wxApp/.test(code);
  const guiRequest = /gui|gtk|\bqt\b|window|desktop|창|화면/i.test(request);
  if (guiCode && guiRequest) return { kind: "gui" };
  return null;
}

/* ---------------- capture ---------------- */

function findChrome(): string | null {
  for (const p of ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  const cache = join(process.env.HOME ?? "", ".cache", "puppeteer", "chrome");
  try {
    for (const ver of readdirSync(cache)) {
      const bin = join(cache, ver, "chrome-linux64", "chrome");
      if (existsSync(bin)) return bin;
    }
  } catch {
    /* no puppeteer cache */
  }
  return null;
}

async function materialize(dir: string, code: string): Promise<void> {
  const plan = planApply(code);
  for (const c of plan.changes) {
    const dest = join(dir, c.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, c.content, "utf8");
  }
}

async function captureWeb(code: string, entry: string): Promise<string | null> {
  const chrome = findChrome();
  if (!chrome) return null;
  const dir = await makeTemp();
  await materialize(dir, code);
  const out = join(dir, "screenshot.png");
  const url = `file://${join(dir, entry)}`;
  const cmd =
    `${JSON.stringify(chrome)} --headless=new --disable-gpu --no-sandbox --hide-scrollbars ` +
    `--screenshot=${JSON.stringify(out)} --window-size=1024,768 ${JSON.stringify(url)}`;
  const gate = checkPermission(cmd);
  if (!gate.allowed) return null;
  try {
    await execAsync(cmd, { timeout: 30_000 });
  } catch {
    return null;
  }
  return existsSync(out) ? out : null;
}

function findBinary(buildDir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["CMakeFiles", ".git"].includes(entry.name)) walk(p);
      } else if (entry.isFile() && statSync(p).mode & 0o111 && !entry.name.includes(".")) {
        const mtime = statSync(p).mtimeMs;
        if (!best || mtime > (best as { path: string; mtime: number }).mtime) {
          best = { path: p, mtime };
        }
      }
    }
  };
  try {
    walk(buildDir);
  } catch {
    return null;
  }
  return best ? (best as { path: string }).path : null;
}

async function captureGui(code: string): Promise<string | null> {
  if (!process.env.DISPLAY || !existsSync("/usr/bin/import")) return null;
  const dir = await makeTemp();
  await materialize(dir, code);
  const gate = checkPermission("cmake build");
  if (!gate.allowed) return null;
  try {
    await execAsync("cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j4", {
      cwd: dir,
      timeout: 240_000,
    });
  } catch {
    return null; // build failed — visual check is best-effort
  }
  const binary = findBinary(join(dir, "build"));
  if (!binary) return null;
  const out = join(dir, "screenshot.png");
  const child = spawn(binary, [], { cwd: dir, detached: true, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 4000)); // let the window map
    await execAsync(`/usr/bin/import -window root ${JSON.stringify(out)}`, { timeout: 15_000 });
  } catch {
    return null;
  } finally {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return existsSync(out) ? out : null;
}

/** Screenshot the generated project (web via headless chrome, gui via X). */
export async function captureScreenshot(target: VisualTarget, code: string): Promise<string | null> {
  try {
    return target.kind === "web" ? await captureWeb(code, target.entry) : await captureGui(code);
  } catch {
    return null;
  }
}
