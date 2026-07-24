import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";

export const PROJECT_COMPOSE_TEMPLATE = `services:
  dev:
    build:
      context: ..
    command: sleep infinity
    working_dir: /workspace
    volumes:
      - ..:/workspace
`;

export async function initializeProject(root: string, force: boolean): Promise<string> {
  const directory = path.join(root, ".dim");
  const target = path.join(directory, "docker-compose.yml");
  await mkdir(directory, { recursive: true });
  if (!force && await fileExists(target)) {
    throw new UserError(`${target} already exists; repeat with --force to overwrite it`);
  }
  const temporary = path.join(directory, `.docker-compose.yml.tmp-${process.pid}-${Date.now()}`);
  await writeFile(temporary, PROJECT_COMPOSE_TEMPLATE, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, target);
  return target;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
