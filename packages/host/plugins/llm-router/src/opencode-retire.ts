/** Retire one reviewed obsolete adapter, not arbitrary DIM-named user files. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export function retireLegacyAdapter(): void {
  const descriptors: number[] = [];
  let retainedPath: string | undefined;
  try {
    const home = homedir(), config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const directory = join(config, "opencode/plugins"), selected = relative(home, directory);
    if (!isAbsolute(config) || selected === ".." || selected.startsWith(".." + sep) || isAbsolute(selected)
      || fs.realpathSync(home) !== home) throw new Error("unanchored configuration");
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    let parent = fs.openSync(home, flags | fs.constants.O_DIRECTORY); descriptors.push(parent);
    const uid = process.getuid?.();
    const checkDirectory = (fd: number) => {
      const info = fs.fstatSync(fd);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw new Error("unsafe directory");
    };
    checkDirectory(parent);
    for (const part of selected.split(sep)) {
      if (!part || part === "." || part === "..") throw new Error("unsafe configuration path");
      try { parent = fs.openSync(`/proc/self/fd/${parent}/${part}`, flags | fs.constants.O_DIRECTORY); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
      descriptors.push(parent); checkDirectory(parent);
    }
    const old = `/proc/self/fd/${parent}/dim-llm-router.js`;
    let file: number;
    try { file = fs.openSync(old, flags); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    descriptors.push(file);
    const before = fs.fstatSync(file);
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 65536) throw new Error("unsafe old adapter");
    const bytes = Buffer.alloc(before.size);
    if (fs.readSync(file, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("incomplete adapter");
    // Exact opencode.js from reviewed 1d442003452f93917e5ed24d4450cbc4323e5cc0
    // local package artifact. No adapter ownership manifest existed in that release.
    if (createHash("sha256").update(bytes).digest("hex") !== "6b688c7bcc9e57cdda3ea6ce8c2e17c49810ad7065436cd3489f33d6129d39d5") throw new Error("unrecognized old adapter bytes");
    const modern = fs.openSync(`/proc/self/fd/${parent}/dim-llm-router.mjs`, flags); descriptors.push(modern);
    const current = fs.fstatSync(modern);
    if (!current.isFile() || current.uid !== uid || current.nlink !== 1 || (current.mode & 0o777) !== 0o600 || !current.size) throw new Error("modern adapter unavailable");
    const again = Buffer.alloc(before.size);
    if (fs.readSync(file, again, 0, again.length, 0) !== again.length || !bytes.equals(again)) throw new Error("old adapter edited during retirement");
    const after = fs.fstatSync(file), named = fs.lstatSync(old);
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== uid || after.mode !== before.mode || after.nlink !== 1
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || named.dev !== after.dev || named.ino !== after.ino || named.nlink !== 1 || named.isSymbolicLink()
      || fs.realpathSync(`/proc/self/fd/${parent}`) !== directory) throw new Error("adapter ownership changed");
    // Capture the pathname atomically before deletion. A late replacement is
    // retained, never unlinked on the strength of the previously opened inode.
    const quarantine = fs.mkdtempSync(`/proc/self/fd/${parent}/.dim-adapter-retirement-`);
    retainedPath = fs.realpathSync(quarantine);
    const staging = fs.openSync(quarantine, flags | fs.constants.O_DIRECTORY); descriptors.push(staging); checkDirectory(staging);
    const captured = `/proc/self/fd/${staging}/retired`;
    fs.renameSync(old, captured);
    const capturedInfo = fs.lstatSync(captured), capturedBytes = Buffer.alloc(before.size);
    if (capturedInfo.dev !== before.dev || capturedInfo.ino !== before.ino || capturedInfo.nlink !== 1
      || capturedInfo.mode !== before.mode || capturedInfo.uid !== uid || capturedInfo.size !== before.size
      || fs.readSync(file, capturedBytes, 0, capturedBytes.length, 0) !== capturedBytes.length || !capturedBytes.equals(bytes)) {
      try { fs.linkSync(captured, old); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      throw new Error("late replacement retained for inspection");
    }
    fs.unlinkSync(captured); fs.fsyncSync(staging); fs.rmdirSync(quarantine); fs.fsyncSync(parent); retainedPath = undefined;
  } catch (error) {
    throw new Error("Cannot safely retire obsolete DIM OpenCode adapter; inspect XDG_CONFIG_HOME/opencode/plugins/dim-llm-router.js (default HOME/.config) and move the conflicting user file out of plugin discovery before retrying tool preparation." + (retainedPath ? ` Captured file retained at ${retainedPath}/retired.` : ""), { cause: error });
  } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}
