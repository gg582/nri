import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * OS-standard storage locations (settings must be non-volatile):
 *   Linux:   $XDG_CONFIG_HOME|~/.config/nri        $XDG_DATA_HOME|~/.local/share/nri
 *   macOS:   ~/Library/Application Support/nri     (same for data)
 *   Windows: %APPDATA%\nri                         %LOCALAPPDATA%\nri
 * NRI_CONFIG_HOME / NRI_DATA_HOME override for tests and portable installs.
 */
export interface StorePaths {
  configDir: string;
  dataDir: string;
  configFile: string;
  runsJsonl: string;
  ragDb: string;
  goalFile: string;
}

export function storePaths(): StorePaths {
  const os = platform();
  const home = homedir();
  let configDir: string;
  let dataDir: string;
  if (process.env.NRI_CONFIG_HOME) {
    configDir = process.env.NRI_CONFIG_HOME;
  } else if (os === "darwin") {
    configDir = join(home, "Library", "Application Support", "nri");
  } else if (os === "win32") {
    configDir = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "nri");
  } else {
    configDir = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "nri");
  }
  if (process.env.NRI_DATA_HOME) {
    dataDir = process.env.NRI_DATA_HOME;
  } else if (os === "darwin") {
    dataDir = join(home, "Library", "Application Support", "nri");
  } else if (os === "win32") {
    dataDir = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "nri");
  } else {
    dataDir = join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "nri");
  }
  return {
    configDir,
    dataDir,
    configFile: join(configDir, "config.json"),
    runsJsonl: join(dataDir, "runs.jsonl"),
    ragDb: join(dataDir, "rag.db"),
    goalFile: join(configDir, "goal.json"),
  };
}
