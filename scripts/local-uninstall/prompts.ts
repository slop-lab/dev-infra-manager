import { createInterface } from "node:readline/promises";
export interface SelectionFlags { readonly yes?: boolean; readonly keepCacheData?: boolean; readonly noKeepCacheData?: boolean; readonly dryRun?: boolean }
export interface Questions { readonly tty: boolean; ask(question: string): Promise<string> }
export function terminalQuestions(): Questions & { close(): void } {
  let prompt: ReturnType<typeof createInterface> | undefined;
  return { tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) { prompt ??= createInterface({ input: process.stdin, output: process.stdout }); return prompt.question(question); },
    close() { prompt?.close(); } };
}
export async function answer(question: string, defaultYes: boolean, input: Questions): Promise<boolean> {
  for (;;) {
    const value = (await input.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!value) return defaultYes;
    if (["y", "yes"].includes(value)) return true;
    if (["n", "no"].includes(value)) return false;
  }
}
export async function selectCacheRetention(flags: SelectionFlags, input: Questions): Promise<boolean> {
  if (flags.keepCacheData && flags.noKeepCacheData) throw new Error("choose only one cache retention option");
  if (flags.keepCacheData) return true;
  if (flags.noKeepCacheData) return false;
  if (flags.yes || flags.dryRun || !input.tty) return true;
  return answer("Keep local registry/package cache data?", true, input);
}
export async function confirmRemoval(flags: SelectionFlags, input: Questions): Promise<boolean> {
  if (flags.dryRun) return false;
  if (flags.yes) return true;
  if (!input.tty) return false;
  return answer("Remove the listed local DIM installation and workspace/service data?", false, input);
}
