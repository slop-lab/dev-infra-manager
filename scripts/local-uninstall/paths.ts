import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { metadata } from "./files.ts";
import type { RemovalPaths } from "./types.ts";
export function removalPaths(env: NodeJS.ProcessEnv = process.env): RemovalPaths {
  const home = resolve(env.HOME ?? homedir()), data = resolve(env.DIM_DATA_HOME ?? join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "dim"));
  const state = resolve(env.DIM_STATE_ROOT ?? join(home, ".local/state/dim"));
  const managed = resolve(env.DIM_MANAGED_STATE_ROOT ?? env.DIM_STATE_ROOT ?? join(home, ".local/state/dim/managed"));
  const runtime = join(env.XDG_RUNTIME_DIR ?? join(tmpdir(), `dim-${process.getuid?.() ?? "user"}`), "dim", "managed");
  const controller = managed === join(home, ".local/state/dim/managed") ? runtime : join(runtime, createHash("sha256").update(managed).digest("hex").slice(0, 16));
  return { home, repository: resolve(fileURLToPath(new URL("../..", import.meta.url))), data, state, managed,
    configuration: resolve(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "dim")),
    config: resolve(env.DIM_CONFIG_PATH ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "dim/config.json")),
    controlPlane: resolve(join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "dim/control-plane")),
    hostPlugins: resolve(env.DIM_PLUGIN_HOME ?? join(data, "runtime/current")),
    controlPlanePlugins: resolve(env.DIM_CONTROL_PLANE_PLUGIN_HOME ?? join(data, "control-plane/runtime/current")),
    runtime: controller, bin: join(resolve(env.DIM_INSTALL_PREFIX ?? join(home, ".local")), "bin/dim"),
    unit: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd/user/dim-controller.service") };
}
export function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export function removalDirectories(paths: RemovalPaths): string[] {
  const roots = [paths.configuration, paths.data, paths.state, paths.managed, paths.controlPlane, paths.hostPlugins, paths.controlPlanePlugins, paths.runtime];
  return [...new Set(roots)].filter((root) => !roots.some((other) => root !== other && inside(root, other))).sort();
}
/** Refuse broad or redirected paths before any command that changes the host. */
export async function validatePaths(paths: RemovalPaths): Promise<void> {
  const forbidden = ["/", paths.home, paths.repository, "/tmp", "/var", "/usr", "/etc", join(paths.home, ".local"), join(paths.home, ".config"), join(paths.home, ".local/share"), join(paths.home, ".local/state")];
  for (const target of [...removalDirectories(paths), paths.config]) {
    if (!isAbsolute(target) || inside(target, paths.repository) || forbidden.some((path) => inside(path, target))) throw new Error(`refusing broad removal path: ${target}`);
    let current = target;
    while (true) {
      const stat = await metadata(current);
      if (stat?.isSymbolicLink()) throw new Error(`refusing symlinked removal path: ${current}`);
      if (current === target && stat && stat.uid !== process.getuid?.()) throw new Error(`removal path is not owned by this user: ${target}`);
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
  }
}
