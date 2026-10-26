import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
const journeys = [
  'web/consoleNavigation.e2e.ts',
  'web/operations.e2e.ts',
  'web/workspaceOperationsRecovery.e2e.ts',
  'web/workspaceDeepLinks.e2e.ts',
  'web/workspacePhaseRecovery.e2e.ts',
  'web/workspaceFeatures.e2e.ts',
  'web/workspaceServices.e2e.ts',
  'web/workspaceReconnect.e2e.ts',
  'web/backgroundCreation.e2e.ts',
  'web/accountAccess.e2e.ts',
  'web/accountManagement.e2e.ts',
  'web/sessionFence.e2e.ts',
  'web/sessionLoginResponse.e2e.ts',
  'web/plugins/agent-tools/panel.e2e.ts',
  'web/plugins/external-urls/panel.e2e.ts',
  'web/executionLocation.e2e.ts',
  'web/executionCancellation.e2e.ts',
  'web/plugins/executionControllers.e2e.ts',
  'web/plugins/llm-router/accounts.e2e.ts',
  'web/plugins/llm-router/accountReadiness.e2e.ts',
  'web/plugins/llm-router/controllerUncertainty.e2e.ts',
  'web/plugins/llm-router/upstreamResponseLoss.e2e.ts',
  'web/plugins/llm-router/draftLifetime.e2e.ts',
  'web/plugins/llm-router/panel.e2e.ts',
  'web/plugins/llm-router/controllers.e2e.ts',
  'web/plugins/llm-router/navigation-resolution.e2e.ts',
  'web/plugins/llm-router/observedUsage.e2e.ts',
  'web/plugins/llm-router/resolutionRace.e2e.ts',
  'web/plugins/llm-router/policyRecovery.e2e.ts',
  'web/plugins/llm-router/routerNavigationLocation.e2e.ts',
] as const;

if (!process.env.DIM_CHROMIUM) throw new Error('DIM_CHROMIUM must select the test browser');
for (const journey of journeys) {
  process.stdout.write(`\nNon-Git journey: ${journey}\n`);
  const child = spawn(process.execPath, ['--disable-warning=DEP0205', '--import', loader, '--conditions=dim-source', journey], {cwd:root, stdio:'inherit'});
  await new Promise<void>((resolve,reject) => {
    child.once('error', reject);
    child.once('exit', (code,signal) => code === 0 ? resolve() : reject(new Error(`${journey} failed: ${code ?? signal ?? 'unknown exit'}`)));
  });
}
process.stdout.write(`\n${journeys.length} disposable non-Git browser journeys passed.\n`);
