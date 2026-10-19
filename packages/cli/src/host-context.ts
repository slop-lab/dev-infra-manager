import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface HostTarget {
  readonly name: string;
  readonly ssh?: string;
}

interface HostConfiguration {
  readonly current: string;
  readonly hosts: readonly HostTarget[];
}

export class HostContextError extends Error {}

/** Client configuration only. Workspace paths and state belong to the selected host. */
export class HostContextStore {
  readonly file: string;

  constructor(configHome = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config")) {
    if (!path.isAbsolute(configHome)) throw new HostContextError("configuration directory must be absolute");
    this.file = path.join(configHome, "dim", "hosts.json");
  }

  async list(): Promise<readonly (HostTarget & { readonly current: boolean })[]> {
    const configuration = await this.read();
    return configuration.hosts.map((host) => ({ ...host, current: host.name === configuration.current }));
  }

  async resolve(name?: string): Promise<HostTarget> {
    const configuration = await this.read();
    const selected = name ?? configuration.current;
    const host = configuration.hosts.find((entry) => entry.name === selected);
    if (!host) throw new HostContextError(`host '${selected}' is not configured; run 'dim host add'`);
    return host;
  }

  async add(target: HostTarget): Promise<void> {
    validateTarget(target);
    if (target.name === "local") throw new HostContextError("the built-in local host cannot be replaced");
    const configuration = await this.read();
    if (configuration.hosts.some((host) => host.name === target.name)) {
      throw new HostContextError(`host '${target.name}' already exists; remove it before replacing it`);
    }
    await this.write({ ...configuration, hosts: [...configuration.hosts, target] });
  }

  async use(name: string): Promise<void> {
    const configuration = await this.read();
    if (!configuration.hosts.some((host) => host.name === name)) {
      throw new HostContextError(`host '${name}' is not configured; run 'dim host add'`);
    }
    await this.write({ ...configuration, current: name });
  }

  async remove(name: string): Promise<void> {
    if (name === "local") throw new HostContextError("the built-in local host cannot be removed");
    const configuration = await this.read();
    if (!configuration.hosts.some((host) => host.name === name)) {
      throw new HostContextError(`host '${name}' is not configured`);
    }
    await this.write({
      current: configuration.current === name ? "local" : configuration.current,
      hosts: configuration.hosts.filter((host) => host.name !== name)
    });
  }

  private async read(): Promise<HostConfiguration> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { current: "local", hosts: [{ name: "local" }] };
      }
      throw error;
    }
    try {
      const value: unknown = JSON.parse(content);
      if (!isRecord(value) || typeof value.current !== "string" || !Array.isArray(value.hosts)
        || Object.keys(value).some((key) => key !== "current" && key !== "hosts")) {
        throw new Error("invalid host configuration");
      }
      const hosts: HostTarget[] = value.hosts.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.name !== "string"
          || (entry.ssh !== undefined && typeof entry.ssh !== "string")
          || Object.keys(entry).some((key) => key !== "name" && key !== "ssh")) {
          throw new Error("invalid host entry");
        }
        const host: HostTarget = { name: entry.name, ...(entry.ssh === undefined ? {} : { ssh: entry.ssh }) };
        validateTarget(host);
        return host;
      });
      if (new Set(hosts.map((host) => host.name)).size !== hosts.length
        || !hosts.some((host) => host.name === "local" && host.ssh === undefined)
        || !hosts.some((host) => host.name === value.current)) {
        throw new Error("invalid host selection");
      }
      return { current: value.current, hosts };
    } catch (error) {
      throw new HostContextError(`invalid host configuration at ${this.file}`, { cause: error });
    }
  }

  private async write(configuration: HostConfiguration): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function validateTarget(target: HostTarget): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.name)) {
    throw new HostContextError("host name must contain 1–64 letters, numbers, dots, underscores or hyphens");
  }
  if (target.name === "local") {
    if (target.ssh !== undefined) throw new HostContextError("the local host cannot have an SSH target");
  } else if (typeof target.ssh !== "string" || target.ssh.length === 0
    || target.ssh.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(target.ssh)) {
    throw new HostContextError("provide one SSH target such as user@host; configure ports and options in SSH config");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
