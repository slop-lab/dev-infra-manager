/** The pinned upstream UI owns sessions and terminals; this adapter only removes its implicit local backend and adds static-host routing. */

function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error("Pinned OpenCode source no longer matches the Pages adapter");
  return source.replace(before, after);
}

export function patchPages(entry: string, app: string) {
  entry = replace(entry, '  return getCurrentUrl()\n}', '  return "opencode://unconfigured"\n}');
  entry = replace(entry, 'servers={[server]}', 'servers={[]}');
  app = replace(app, 'import { DialogProvider } from "@opencode-ai/ui/context/dialog"',
    'import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"');
  app = replace(app, 'import { CommandProvider, useCommand, type CommandOption } from "@/context/command"',
    'import { CommandProvider, useCommand, type CommandOption } from "@/context/command"\nimport { DialogSelectServer } from "@/components/dialog-select-server"');
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
    '                          <Show when={useServer().current} fallback={routerProps.children}>\n                            <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>\n                              <NewAppLayout serverScoped={props.serverScoped}>{routerProps.children}</NewAppLayout>\n                            </Show>\n                          </Show>');
  const start = app.indexOf('function Routes(');
  if (start < 0) throw new Error("Pinned OpenCode routes were not found");
  let routes = app.slice(start);
  routes = replace(routes, '  return (\n    <>', '  return (\n    <Show when={useServer().current} fallback={<Route path="*" component={DisconnectedServer} />}>\n    <>');
  routes = replace(routes, '      <Route path="/new-session" component={DraftRoute} />\n    </>\n  )\n}\n\nfunction NewLayoutLegacySessionRedirect',
    '      <Route path="/new-session" component={DraftRoute} />\n    </>\n    </Show>\n  )\n}\n\nfunction NewLayoutLegacySessionRedirect');
  app = app.slice(0, start) + routes;
  app = replace(app, '  Navigate,\n  Route,', '  HashRouter,\n  Navigate,\n  Route,');
  app = replace(app, 'component={props.router ?? Router}', 'component={props.router ?? HashRouter}');
  return { entry, app };
}
