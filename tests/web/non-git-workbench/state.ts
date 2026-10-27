import {z} from 'zod';
const workspaceSchema = z.strictObject({
  id:z.string().uuid(), name:z.string(), runtime:z.string(), phase:z.string(), runtimeStatus:z.string(),
  initialized:z.boolean().optional(), failureCode:z.string().optional(),
  resources:z.strictObject({cpuCount:z.string(),memory:z.string(),pidsLimit:z.string()})
});
const routeSchema = z.strictObject({
  id:z.string().uuid(), ingress:z.string(), url:z.string().url(), permalink:z.string().url().optional(),
  approval:z.enum(['not-required','pending','approved','revoked']), port:z.number().int().min(1).max(65535),
  containers:z.array(z.string()), protocol:z.enum(['http','https','tcp'])
});
const stateSchema = z.strictObject({hosts:z.record(z.string(),z.strictObject({
  available:z.boolean(),workspaces:z.array(workspaceSchema),servers:z.record(z.string(),z.enum(['running','stopped'])),routes:z.record(z.string(),z.array(routeSchema))
}))});
export type WorkbenchState = z.infer<typeof stateSchema>;

export function parseWorkbenchState(input: string): WorkbenchState {
  return stateSchema.parse(JSON.parse(input));
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
