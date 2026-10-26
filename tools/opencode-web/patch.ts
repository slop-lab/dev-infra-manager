/** The pinned upstream UI owns sessions and terminals; this adapter only removes its implicit local backend and adds static-host routing. */

function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error("Pinned OpenCode source no longer matches the Pages adapter");
  return source.replace(before, after);
}

export function patchPages(entry: string, app: string, serverDialog: string) {
  entry = replace(entry, '  return getCurrentUrl()\n}', '  return "opencode://unconfigured"\n}');
  entry = replace(entry, 'servers={[server]}', 'servers={[]}');
  entry = replace(entry,
    '    const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))\n    clearAuthToken()',
    '    const dimWorkspaceLink = location.hash === "#/dim/open" || location.hash.startsWith("#/dim/open?")\n    const auth = dimWorkspaceLink ? undefined : authFromToken(new URLSearchParams(location.search).get("auth_token"))\n    if (!dimWorkspaceLink) clearAuthToken()');
  app = replace(app, 'import { DialogProvider } from "@opencode-ai/ui/context/dialog"',
    'import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"');
  app = replace(app, 'import { CommandProvider, useCommand, type CommandOption } from "@/context/command"',
    'import { CommandProvider, useCommand, type CommandOption } from "@/context/command"\nimport { DialogSelectServer } from "@/components/dialog-select-server"\nimport { DimWorkspaceOpen } from "@/dim-workspace-open"');
  app = replace(app, 'export function AppInterface(props: {', `function DisconnectedServer() {
  const dialog = useDialog()
  const language = useLanguage()
  return <div class="h-full w-full flex items-center justify-center">
    <button type="button" class="px-4 py-2 rounded-md bg-surface-raised-base text-text-strong"
      onClick={() => dialog.show(() => <DialogSelectServer />)}>{language.t("dialog.server.add.button")}</button>
  </div>
}

export function AppInterface(props: {`);
  app = replace(app, '<Show when={server.key} keyed>', '<Show when={server.current} keyed>');
  app = replace(app,
    '                          <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>\n                            <NewAppLayout serverScoped={props.serverScoped}>{routerProps.children}</NewAppLayout>\n                          </Show>',
    '                          <RouteLayout serverScoped={props.serverScoped}>{routerProps.children}</RouteLayout>');
  app = replace(app, 'function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {\n  const server = useServer()',
    'function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {\n  if (typeof window !== "undefined" && (window.location.hash === "#/dim/open" || window.location.hash.startsWith("#/dim/open?"))) return <>{props.children}</>\n  const server = useServer()');
  app = replace(app, 'export function AppInterface(props: {', `function RouteLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  const location = useLocation()
  return (
    <Show when={location.pathname !== "/dim/open"} fallback={props.children}>
      <Show when={useServer().current} fallback={props.children}>
        <Show when={useSettings().general.newLayoutDesigns()} fallback={props.children}>
          <NewAppLayout serverScoped={props.serverScoped}>{props.children}</NewAppLayout>
        </Show>
      </Show>
    </Show>
  )
}

export function AppInterface(props: {`);
  const start = app.indexOf('function Routes(');
  if (start < 0) throw new Error("Pinned OpenCode routes were not found");
  let routes = app.slice(start);
  routes = replace(routes, '  return (\n    <>', '  return (\n    <>\n      <Route path="/dim/open" component={DimWorkspaceOpen} />\n      <Show when={useServer().current} fallback={<Route path="*" component={DisconnectedServer} />}>\n      <>');
  routes = replace(routes, '      <Route path="/new-session" component={DraftRoute} />\n    </>\n  )\n}\n\nfunction NewLayoutLegacySessionRedirect',
    '      <Route path="/new-session" component={DraftRoute} />\n    </>\n    </Show>\n    </>\n  )\n}\n\nfunction NewLayoutLegacySessionRedirect');
  app = app.slice(0, start) + routes;
  app = replace(app, '  Navigate,\n  Route,', '  HashRouter,\n  Navigate,\n  Route,');
  app = replace(app, 'component={props.router ?? Router}', 'component={props.router ?? HashRouter}');
  serverDialog = replace(serverDialog, '  onBack: () => void\n}', '  onBack: () => void\n  readonlyUrl?: boolean\n}');
  serverDialog = replace(serverDialog, '            disabled={props.busy}\n            onChange={props.onChange}', '            disabled={props.busy}\n            readOnly={props.readonlyUrl}\n            onChange={props.onChange}');
  serverDialog = replace(serverDialog,
    'export function ServerConnectionForm(props: { controller: ReturnType<typeof useServerManagementController> }) {',
    'export function ServerConnectionForm(props: { controller: ReturnType<typeof useServerManagementController>; readonlyUrl?: boolean }) {');
  serverDialog = replace(serverDialog, '        onBack={props.controller.resetForm}\n      />', '        onBack={props.controller.resetForm}\n        readonlyUrl={props.readonlyUrl}\n      />');
  serverDialog = replace(serverDialog,
    'options: { onSelect?: () => void; navigateOnAdd?: boolean } = {}',
    'options: { onSelect?: () => void; navigateOnAdd?: boolean; onConnected?: (connection: ServerConnection.Http) => void } = {}');
  serverDialog = replace(serverDialog, '        server.add(conn)\n        options.onSelect?.()',
    '        server.add(conn)\n        options.onConnected?.(conn)\n        options.onSelect?.()');
  serverDialog = replace(serverDialog, '      resetEdit()\n    },\n  }))',
    '      resetEdit()\n      options.onConnected?.(conn)\n    },\n  }))');
  return { entry, app, serverDialog };
}
