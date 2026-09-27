import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type LockChild = {
  readonly ready: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly started: () => Promise<void>;
  readonly contended: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly acquired: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly kill: () => Promise<void>;
};

const childSource = fileURLToPath(new URL("./lifecycleLockChild.ts", import.meta.url));
const childWaitTimeoutMs = 4_000;

async function bounded<T>(operation: Promise<T>, description: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`timed out waiting for lock child ${description}`)), childWaitTimeoutMs);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function startLockChild(root: string, name: string): LockChild {
  const child = spawn(process.execPath, ["--import", "tsx", childSource, root, name], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const waitForOutput = async (event: string): Promise<void> => {
    const marker = `${event}\n`;
    if (stdout.includes(marker)) return;
    await bounded(new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.stdout.off("data", onData);
        child.off("close", onClose);
      };
      const onData = (): void => {
        if (!stdout.includes(marker)) return;
        cleanup();
        resolve();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`lock child exited ${String(code ?? signal)} before ${event}: ${stderr}`));
      };
      child.stdout.on("data", onData);
      child.once("close", onClose);
    }), event);
  };
  const send = async (command: string): Promise<void> => {
    await bounded(new Promise<void>((resolve, reject) => {
      child.stdin.write(`${command}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    }), `${command} command delivery`);
  };
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await bounded(new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    }), "termination");
  };
  return {
    ready: () => waitForOutput("ready"),
    start: () => send("start"),
    started: () => waitForOutput("started"),
    contended: () => waitForOutput("contended"),
    retry: () => send("retry"),
    acquired: () => waitForOutput("acquired"),
    release: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await send("release");
      await waitForOutput("released");
      await close();
    },
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await close();
    }
  };
}
