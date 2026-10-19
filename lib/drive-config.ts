import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export class DriveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export const READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export type Grant = "read" | "write";
export const folderNames = ["Projects", "Templates", "Architecture"] as const;
export type FolderName = (typeof folderNames)[number];
export interface DriveConfig {
  schemaVersion: 1;
  infisical: { configDir: string; environment: string; path: string };
  folders: Record<FolderName, { id: string; write: boolean }>;
}

export function driveId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value) || value === "root")
    throw new DriveError(
      "INVALID_ID",
      "Use an explicit Drive file or folder ID.",
    );
  return value;
}

// The agent cannot edit its runtime policy directory through the Wood file gate.
// No credential values belong in this configuration.
export function loadDriveConfig(agentDir: string): DriveConfig {
  try {
    if (!isAbsolute(agentDir)) throw new Error();
    const directory = lstatSync(agentDir);
    const path = join(agentDir, "google-drive.json");
    const file = lstatSync(path);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0 ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size > 16_384 ||
      (file.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.() ||
      file.uid !== process.getuid?.()
    )
      throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8")) as DriveConfig;
    if (
      value.schemaVersion !== 1 ||
      !isAbsolute(value.infisical.configDir) ||
      !/^[A-Za-z0-9_-]+$/.test(value.infisical.environment) ||
      !/^\/[A-Za-z0-9_/-]+$/.test(value.infisical.path) ||
      value.infisical.path.includes("..") ||
      !folderNames.every(
        (name) =>
          value.folders[name] &&
          typeof value.folders[name].write === "boolean" &&
          driveId(value.folders[name].id),
      ) ||
      new Set(folderNames.map((name) => value.folders[name].id)).size !== 3
    )
      throw new Error();
    realpathSync(join(value.infisical.configDir, ".infisical.json"));
    return value;
  } catch {
    throw new DriveError(
      "CONFIGURATION_REQUIRED",
      "Configure a private, owner-only google-drive.json in the explicit Pi agent directory; see docs/google-drive.md.",
    );
  }
}

export function safeDriveError(error: unknown) {
  return error instanceof DriveError
    ? {
        code: error.code,
        message: error.message,
        ...(error.status ? { status: error.status } : {}),
      }
    : {
        code: "DRIVE_OPERATION_FAILED",
        message:
          "Drive operation failed; check configuration and connectivity. Raw responses are withheld.",
      };
}
