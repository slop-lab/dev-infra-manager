import { ServerConnection, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useTabs, type DraftTab } from "@/context/tabs"
import { ServerConnectionForm, useServerManagementController } from "@/components/dialog-select-server"
import { checkServerHealth } from "@/utils/server-health"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useNavigate } from "@solidjs/router"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { normalizeWorkspaceEndpoint, parseWorkspaceClientLink } from "./dim-workspace-link.js"

type Phase = "checking" | "auth" | "unavailable" | "opening" | "failed" | "invalid"

const invalidMessage = "This workspace link is invalid."

export function DimWorkspaceOpen() {
  const server = useServer()
  const platform = usePlatform()
  const settings = useSettings()
  const tabs = useTabs()
  const navigate = useNavigate()
  const target = window.location.search ? undefined : parseWorkspaceClientLink(window.location.hash)
  const [phase, setPhase] = createSignal<Phase>(target ? "checking" : "invalid")
  let running = false
  let alive = true
  let healthController: AbortController | undefined
  const controller = useServerManagementController({
    navigateOnAdd: false,
    onConnected(connection) {
      if (!alive || phase() !== "auth" || !target || normalizeWorkspaceEndpoint(connection.http.url) !== target.endpoint) return
      setPhase("opening")
      void openWorkspace(connection).catch(() => { if (alive) setPhase("failed") })
    },
  })

  const existingConnection = () => {
    if (!target) return
    return server.list.find(
      (connection): connection is ServerConnection.Http =>
        connection.type === "http" && normalizeWorkspaceEndpoint(connection.http.url) === target.endpoint,
    )
  }

  const showAuthentication = (connection?: ServerConnection.Http) => {
    setPhase("auth")
    if (controller.isFormMode()) return
    if (connection) {
      controller.startEdit(connection)
      return
    }
    controller.startAdd()
    controller.handleFormChange()(target?.endpoint ?? "")
  }

  const openWorkspace = async (connection: ServerConnection.Http) => {
    if (!target) return
    const key = ServerConnection.key(connection)
    server.setActive(key)
    await platform.setDefaultServer?.(key)
    if (!alive) return
    const projects = server.projects.forServer(key)
    projects.open(target.directory)
    projects.touch(target.directory)
    if (!settings.general.newLayoutDesigns()) {
      navigate(`/${base64Encode(target.directory)}/session`, { replace: true })
      return
    }
    if (!tabs.ready()) await tabs.ready.promise
    const draft = tabs.store.find(
      (tab): tab is DraftTab =>
        tab.type === "draft" && tab.server === key && tab.directory === target.directory,
    )
    if (draft) {
      tabs.select(draft)
      return
    }
    await tabs.newDraft({ server: key, directory: target.directory })
  }

  const attempt = async () => {
    if (!target || running) return
    running = true
    setPhase("checking")
    const existing = existingConnection()
    let authenticationRequired = false
    const healthAbort = new AbortController()
    healthController = healthAbort
    const timeout = setTimeout(() => healthAbort.abort(), 5_000)
    const fetcher = platform.fetch ?? globalThis.fetch
    const guardedFetch: typeof globalThis.fetch = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        const response = await fetcher(input, { ...init, redirect: "error" })
        if (response.status === 401 || response.status === 403) authenticationRequired = true
        return response
      },
      { preconnect: fetcher.preconnect },
    )
    try {
      const result = await checkServerHealth(existing?.http ?? { url: target.endpoint }, guardedFetch, {
        signal: healthAbort.signal,
        retryCount: 0,
      })
      if (!alive) return
      if (!result.healthy) {
        if (authenticationRequired) showAuthentication(existing)
        else setPhase("unavailable")
        return
      }
      const connection = existing ?? server.add({ type: "http", http: { url: target.endpoint } })
      if (!connection) {
        setPhase("unavailable")
        return
      }
      setPhase("opening")
      await openWorkspace(connection)
    } catch {
      if (alive) setPhase("failed")
    } finally {
      clearTimeout(timeout)
      if (healthController === healthAbort) healthController = undefined
      running = false
    }
  }

  const cancelAuthentication = () => {
    controller.resetForm()
    setPhase("unavailable")
  }
  const formController = { ...controller, resetForm: cancelAuthentication }

  onMount(() => {
    if (!target) {
      history.replaceState(history.state, "", window.location.pathname)
      return
    }
    void attempt()
  })
  onCleanup(() => {
    alive = false
    healthController?.abort()
  })

  return (
    <main class="h-dvh w-screen flex items-center justify-center bg-background-base p-6">
      <section class="w-full max-w-md flex flex-col gap-4" aria-live="polite">
        <Show when={phase() === "invalid"}>
          <p class="text-14-regular text-text-strong text-center">{invalidMessage}</p>
        </Show>
        <Show when={phase() === "checking" || phase() === "opening"}>
          <div class="flex flex-col items-center gap-3 text-text-weak">
            <Spinner class="size-6" />
            <p class="text-14-regular">{phase() === "checking" ? "Connecting to OpenCode…" : "Opening workspace…"}</p>
          </div>
        </Show>
        <Show when={phase() === "unavailable"}>
          <div class="flex flex-col items-center gap-3 text-center">
            <p class="text-14-medium text-text-strong">The OpenCode server is unavailable.</p>
            <p class="text-12-regular text-text-weak">Check that the workspace server is running, then retry.</p>
            <Button variant="primary" size="large" onClick={() => void attempt()}>Retry</Button>
          </div>
        </Show>
        <Show when={phase() === "failed"}>
          <div class="flex flex-col items-center gap-3 text-center">
            <p class="text-14-medium text-text-strong">The workspace could not be opened.</p>
            <p class="text-12-regular text-text-weak">Retry the connection, or return to the server form.</p>
            <Button variant="primary" size="large" onClick={() => void attempt()}>Retry</Button>
          </div>
        </Show>
        <Show when={phase() === "auth"}>
          <div class="flex flex-col gap-4">
            <div class="text-center">
              <p class="text-14-medium text-text-strong">Authentication required</p>
              <p class="mt-1 text-12-regular text-text-weak">Enter this server’s existing credentials to continue.</p>
            </div>
            <ServerConnectionForm controller={formController} readonlyUrl />
            <Button variant="ghost" size="large" onClick={cancelAuthentication}>Back</Button>
          </div>
        </Show>
      </section>
    </main>
  )
}
