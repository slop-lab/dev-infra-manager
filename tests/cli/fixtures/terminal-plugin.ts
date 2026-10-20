
export const hostPlugin: import('@slop-lab/dim-host-core/workspace').WorkspaceHostPlugin = {
  name: "terminal-probe",
  commands: [{ name: "terminalprobe", description: "Test inherited operator terminal" }],
  async run(args) {
    if (args[1] === "echo") { process.stdin.pipe(process.stdout); return; }
    console.log(JSON.stringify({ stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, args }));
  }
};
