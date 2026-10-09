import { execFileSync } from "node:child_process";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseSnapshot } from "./footer.ts";

export function repositoryIdentity(cwd: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      timeout: 2000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const root = git("rev-parse", "--show-toplevel");
    return {
      root,
      repository: basename(root),
      revision: git("rev-parse", "HEAD"),
      dirty:
        git("status", "--porcelain", "--untracked-files=normal").length > 0,
    };
  } catch {
    return { root: cwd, repository: basename(cwd), revision: "", dirty: true };
  }
}

export function readSnapshot(root: string) {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(root, ".pi/wood-footer.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return;
    return parseSnapshot(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
