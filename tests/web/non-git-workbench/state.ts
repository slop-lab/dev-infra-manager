type Workspace = {
  readonly id: string;
  readonly name: string;
  readonly runtime: string;
  phase: string;
  runtimeStatus: string;
  readonly initialized?: boolean;
  readonly failureCode?: string;
  resources: { readonly cpuCount: string; readonly memory: string; readonly pidsLimit: string };
};

type Route = {
  readonly id: string;
  readonly ingress: string;
  readonly url: string;
  readonly permalink?: string;
  approval: "not-required" | "pending" | "approved" | "revoked";
  readonly port: number;
  readonly containers: readonly string[];
  readonly protocol: "http" | "https" | "tcp";
};

type Host = {
  readonly available: boolean;
  readonly workspaces: Workspace[];
  readonly servers: Record<string, "running" | "stopped">;
  readonly routes: Record<string, Route[]>;
};

export type WorkbenchState = { readonly hosts: Record<string, Host> };

export function parseWorkbenchState(input: string): WorkbenchState {
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("hosts" in value)) throw new Error("invalid workbench state");
  return value as WorkbenchState;
}

export const WORKSPACE_IDS = {
  running: "17094660-a627-4a17-acd2-6418c0b79967",
  stopped: "27094660-a627-4a17-acd2-6418c0b79967",
  incomplete: "37094660-a627-4a17-acd2-6418c0b79967"
} as const;

export function initialWorkbenchState(): WorkbenchState {
  return {
    hosts: {
      local: {
        available: true,
        workspaces: [
          { id: WORKSPACE_IDS.running, name: "studio", runtime: "container", phase: "running", runtimeStatus: "running", resources: { cpuCount: "4", memory: "8g", pidsLimit: "2048" } },
          { id: WORKSPACE_IDS.stopped, name: "archive", runtime: "container", phase: "stopped", runtimeStatus: "stopped", resources: { cpuCount: "2", memory: "4g", pidsLimit: "1024" } },
          { id: WORKSPACE_IDS.incomplete, name: "bootstrap-failed", runtime: "container", phase: "error", runtimeStatus: "missing", initialized: false, failureCode: "image_unavailable", resources: { cpuCount: "2", memory: "4g", pidsLimit: "1024" } }
        ],
        servers: { [WORKSPACE_IDS.running]: "running", [WORKSPACE_IDS.stopped]: "stopped" },
        routes: {
          [WORKSPACE_IDS.running]: [{ id: "47094660-a627-4a17-acd2-6418c0b79967", ingress: "shared", url: "https://studio.synthetic.example", permalink: "https://studio.permanent.synthetic.example", approval: "approved", port: 4096, containers: [], protocol: "http" }]
        }
      },
      remote: {
        available: true,
        workspaces: [{ id: "57094660-a627-4a17-acd2-6418c0b79967", name: "remote-lab", runtime: "container", phase: "running", runtimeStatus: "running", resources: { cpuCount: "8", memory: "16g", pidsLimit: "4096" } }],
        servers: {},
        routes: {}
      },
      offline: { available: false, workspaces: [], servers: {}, routes: {} }
    }
  };
}
