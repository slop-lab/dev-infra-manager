# Preserved issue implementation

This work implements the 32 open `dim-dim/root` issues and their comments exported
on 2026-10-18. The source database was copied read-only and compared:
all 32 issues and 80 comments match the preserved backup, whose checksums pass.
The original backup and attachment remain unchanged outside the repository.

Optional features belong to plugins. Base workspace lifecycle and narrow typed
extension ports belong to core; host composition and SSH dispatch belong to CLI.
Prior progress comments are evidence to check, not acceptance. A source test does
not establish actual KVM, account authentication, or deployed service behavior.

| Issue | Requested outcome | Implementation / acceptance |
| --- | --- | --- |
| #1 | local cache를 거치지 않는 docker hub pull 감지? | `packages/host/plugins/cache-server`: host cache ownership; `packages/host/plugins/mirrors`: workspace relay/guest configuration; default direct-Hub fallback is blocked. Actual nested Debian/Ubuntu cold and warm pulls, loss of cache Internet access, cache IP replacement and cache outage passed; direct Hub fallback remained blocked. |
| #3 | CI 이미지 캐시 | `packages/control-plane/plugins/ci-workflows` owns workflow interpretation; CI uses shared prepared runtime capacity and host-mirror capability instead of per-project runner images. The provider delivers read-only job configuration. Actual container and KVM CI with ordinary Ubuntu images passed DNS, APT installation and workspace output checks. |
| #4 | codex helper 및 example, 연계 검증 추가 | `dim-workspace-ssh` and core guest-client documentation provide public-key SSH and a tool-neutral `dim connect` ProxyCommand. Actual public-key SSH through the selected remote host and `dim connect` ProxyCommand passed before/after restart and recreation, with pinned guest host keys. |
| #6 | 개발환경 설정 편의성 개선 및 관련 방향성 변경 | `packages/host/plugins/agent-tools` owns pinned Codex/OpenCode/OMO setup and launch for ordinary repositories. Actual pinned setup and OpenCode serve/reuse passed; repository `.dim` contains no tool bootstrap. |
| #8 | 오류 메시지 내용로 오류가 어떤 단계에서 발생했는지 알 수 있도록 수정 | Workspace failures include operation, workspace, lifecycle phase and original cause; CLI prints one doctor hint. Lifecycle failure/retained-state tests passed. |
| #11 | 서비스 재시작 후 workspace의 Git 접속 복구 | Managed Git broker setup is recovered at start/exec/restart/recreate; scoped agent bridges and plugin hooks are refreshed after self operations and resource-triggered recreation. |
| #15 | example workspace restart 등 검증 추가 | Actual Sysbox and selected-SSH-host checks cover stop/start/recreate, binary forwarding, cancellation and data retention. Extended runtime check also covers SSH keys, TMPDIR, services and sessions. |
| #22 | 자체 워크스페이스 재생성 기능 추가 | Workspace-only HTTP capability accepts self restart/recreate without host credentials or a workspace selector. UUID is checked inside lifecycle lock. Actual persisted services/sessions survive recreation; scoped HTTP tests passed. |
| #24 | VM 기반 workspace backend 추가 | `packages/host/plugins/vm` implements the Incus workspace runtime and guest client delivery. Actual KVM guest boot, Docker and browser SPICE passed. Normal-user lifecycle, nested Docker, persistent data and guest reboot passed. A root-owned admission wrapper applies limits before QEMU exec, including replacement processes. |
| #27 | 프로젝트별 ci runner 이미지 필요하지 않도록 수정 | CI workflow plugin selects public `container`/`vm` capacity, uses shared host slots and ordinary job configuration. Prepared connection, execution and real Git/CI tests passed. |
| #29 | opencode 설정 툴 external-url slug opencode로 고정 | Agent-tools requests the fixed `opencode` service identifier; external-urls derives a workspace-specific DNS identity including a name hash. No user-selected random OpenCode slug. |
| #31 | opencode 사용하도록 설정된 repo에 프로젝트와 무관한 opencode 설정 없어야 함 | OpenCode/OMO/bootstrap assets live in `packages/host/plugins/agent-tools`; project-independent setup was removed from `.dim` and example repositories. |
| #32 | opencode 임시 작업물이 컨테이너 안에서 /tmp 경로에 들어가지 않도록 설정 변경 | Separate owned `/mnt/dim-tmp` volume, private mode0700, initialized before tool use; OpenCode uses its own subdirectory. Actual restart/recreate retention and discard removal passed. |
| #34 | 테스트에서 파일 간 병렬 실행을 cpu 코어 수에 따라 조정할 수 있도록 하는 nproc 추가 | Backend-neutral `dim-workspace resources` and `dim-nproc` read assigned limits, including fractional and unlimited CPU handling. Guest-client behavioral tests passed. |
| #35 | docker/apt registry mirror 플러그인 추가/분리 및 대체, 추가 확장 기반 및 방향성 확립 | Cache lifecycle/state/ownership belongs to independent `packages/host/plugins/cache-server`; `packages/host/plugins/mirrors` owns client routing/configuration consumed by workspaces and managed CI. Actual nested cold/warm/offline/cache-IP replacement checks passed. Optional `.dim/workspace.json` declares exact packages; missing plugins fail before runtime creation, or receive explicit TTY operator approval on the selected host followed by source-commit revalidation. |
| #37 | 시스템 리소스 제한 변경 | Container limits support live updates and data-preserving unlimited reset; actual lifecycle passed. VM guest allocation and host cgroup ceilings are separate; actual CPU throttling, unlimited reset and fresh-process reboot limits passed. Releasing touched guest memory returned 282,669,056 bytes to the host with zero swap. Guest allocation changes require a stopped VM; host ceilings remain live. |
| #38 | dim 없는 프로젝트 사용 가능하게 수정 | Ordinary Git URL/local committed source works without Project registration, `.dim`, controller or plugins. Root aliases include `dim ls`, shell/exec and custom run. |
| #39 | 간단한 웹 서버를 external-urls 플러그인을 통해 expose하는 기능 적절한 example에 추가 | In-guest `dim-expose` and `dim-expose list` use the external-urls plugin and scoped host approval path. External URL example and agent-facing skill document the loopback HTTP flow. |
| #40 | 선택형 control-plane Git host 구현 | Independent `git-repositories`, `code-review`, `merge-policy`, `git-ci` and `webhooks` control-plane plugins own repository transport/CAS, human decisions, promotion authorization, execution evidence and external delivery respectively. Repository-only and review-without-CI real Git/HTTP checks passed, alongside neutral CAS crash recovery, human approval/revocation integrity and durable webhook backfill. Workflow compilation, CI coordination and host workers remain separately selected capabilities. |
| #41 | web ui 추가(별도 패키지, #40 이후) | Separate web package provides reader/operator/reviewer roles, workspace creation/lifecycle/resources through configured hosts, CI logs/capacity/cancel/retry and Git review/promotion. Actual Chromium operator creation and reader denial passed, alongside real Git/CI integration. No deployed site is claimed. |
| #44 | 에이전트 컨테이너 내부에 workspace backend 중립 dim 공통 인터페이스 제공 | Core guest client provides runtime-independent resource/lifecycle/service/session operations and scoped plugin discovery/calls. Plugins prepare their clients through shared delivery; External URLs owns `dim-expose`. Host composition owns runtime selection; no host-admin credential enters the guest. |
| #45 | dim installer facade 동작 변경 | Stable installer facade retains `installer install core|plugin|control-plane`; base-only dependency graph and matching source bundles keep managed services optional. Actual matched-facade reinstall, mise selection, six-plugin installation/discovery and absence of managed/native Git dependencies passed. The 16-artifact source bundle includes the separately installable `dim-web`; its standalone install also passed without managed/native Git. |
| #47 | .dim 수정 시 workspace 재시작 등의 동작을 간단히 테스트할 방법 추가 | `packages/host/plugins/workspace-check` creates only a new disposable workspace, checks checkout/home/nested Docker through restart/recreate and discards even after failure/cancellation with fresh UUID-fenced cleanup. Four behavioral tests passed. |
| #48 | self workspace restart 등의 api를 통해 workspace만 재시작하는 게 아니라 에이전트 세션도 이어서 진행할 수 있어야 함 | Generic saved session and independent service registry live in persistent home. Agent-tools owns Codex `exec resume --last` and OpenCode `run --continue`; actual generic restart/recreate resume passed. Provider login is explicit. |
| #49 | rootlesskit 아래의 좀비 containerd-shim 프로세스 누수 | Base image uses its own rootful nested dockerd under tini rather than the leaking rootlesskit topology. Actual repeated nested container execution left no rootlesskit/containerd-shim zombies; discard removed all owned resources. |
| #50 | opencode web 헬퍼 스크립트 cors origin 변경 | Agent-tools runs `opencode serve`; separate pinned static web client uses the explicit GitHub Pages CORS origin. Actual upstream static build and Chromium no-implicit-backend/Add-server checks passed. Main/development Actions deployments preserve versioned URLs; the development deployment and public-site Chromium acceptance passed. |
| #51 | 호스트 llm api router 플러그인 추가 | `packages/control-plane/plugins/llm-router` owns application projects, scoped issuer enrollment, backend keys, atomic allowances, usage/capture, cancellation and credential-aware backup/restore. `packages/host/plugins/llm-router` owns workspace UUID fencing, a private gateway and OpenCode/OMO attachment; guests receive only local gateway credentials. Actual local HTTP/SQLite/compiled-CLI tests exercise both roles, scopes, stale identity and stream cancellation. The [acceptance record](../../packages/control-plane/plugins/llm-router/docs/attachment-acceptance.md) distinguishes current split-role checks from earlier device OAuth, real Codex/OMO and Pages chat evidence. Strict token/currency ceilings and provider continuation remain unsupported. |
| #52 | external-urls AI 에이전트가 사용하기 좋게 문서화 | External-urls package ships an agent-facing skill and concrete expose/URLs/approval instructions; plugin build includes the skills directory; installing the package does not automatically register a skill in every agent. |
| #53 | persist VM 플러그인 및 웹 ip-KVM 추가 | `packages/host/plugins/vm` owns persistent auxiliary VMs, workspace UUID-scoped grants and SPICE browser console, with host credentials outside guests. Actual KVM/Docker, browser SPICE display and keyboard input, helper rejection boundaries, reboot limits and scoped discard passed. Persistent boot services resumed the registered service/session exactly once. |
| #54 | 터널 플러그인 추가 | `packages/host/plugins/tunnels` owns durable TCP/UDP routes, scoped grants, guest service attachment and separate authenticated operator UI. Seven real socket/process/HTTP tests and actual Chromium add/remove/revoke flow passed. |
| #55 | controller 및 web ui server를 oom killer로부터 보호 | Base containers, CI container/VM supervisors and VM admission use positive workload OOM preference, keeping controller/web at the host default. Actual base/CI and VM before-exec/reboot checks passed; the replacement QEMU process retained OOM preference 500. |
| #56 | 기본 에이전트 이미지에 docker buildx 등 의존성 보강 설치 | Base image installs and verifies Docker buildx and Compose alongside Git/SSH/Node tooling. Actual image build and running-workspace version checks passed. |

## Verification record

The structural-refactor production source checkpoint is `f4d40475`; the record
below describes that checkpoint. Its verification used disposable resources
without replacing installed services or modifying the source issue database.
The subsequent installed-router and Pages acceptance is recorded separately below.

- Pinned Node 24.19.0 and 26.5.0 source checks both pass strict JS/TS checks,
  production builds, 1,268 central behavioral tests, 96 CLI tests and 150
  installation/verification tests (two separately reported skips), followed by
  all 132 privileged QEMU/service fixture tests. Both complete gates exit zero. The command
  is `DIM_SOURCE_NODE_MAJOR=24 bash scripts/checks/source-gate-container.bash`;
  run it again with `DIM_SOURCE_NODE_MAJOR=26` for the other supported lane.
- All 82 ordinary JS/MJS/CJS source files contain `// @ts-check` and belong to
  the strict JavaScript project; none is omitted from that check.
- The complete production graph builds. An isolated exact-commit source build
  produces 16 artifacts with one matching source-derived version, including the
  optional Web application. Actual facade reinstall, mise selection, six-plugin
  discovery and standalone `dim-web` execution verify the package boundaries.
- Actual final Sysbox lifecycle checks cover checkout/home/Docker/TMPDIR
  retention, resource changes, current-boot readiness, immediate SSH after
  restart/recreation, independent services and session continuation, zombie
  checks and owned discard. The compiled CLI also passes scoped self operations.
- Actual selected-host SSH checks cover public-key `dim connect` ProxyCommand,
  pinned guest host identity, restart/recreation, binary/concurrent forwarding,
  half-close responses and cancellation cleanup. Disposable hosts, networks,
  workspaces and all four data volumes are removed afterward.
- Separate actual KVM/Incus and container/KVM CI checks cover the evidence in
  the table above; source tests alone are not used to claim those results.

## Installed router and public Pages acceptance

The follow-up production checkpoint `a644825d` was installed locally using the
matching source installer selected by mise. Agent-tools and LLM-router are
optional plugins. The verification used the installed control-plane services.

Development's Pages deployment succeeded in Actions run `39190026587` and serves
[pinned OpenCode 1.18.31](https://slop-lab.github.io/dev-infra-manager/opencode-web/).
Actual Chromium interaction connected the workspace server, selected `/workspace`,
opened a session and sent a prompt through the composer. The visible assistant
reply was `DIM_PAGES_ROUTER_OK`, with no model override or browser errors.

The user completed a separate device OAuth login for CLIProxyAPI 8.0.33. Real
installed OpenCode/OMO helpers used the reviewed `gpt-6-luna` route for file-read
tool execution and follow-up. Host Codex credentials were not reused. See the
plugin's [live acceptance record](../../packages/control-plane/plugins/llm-router/docs/attachment-acceptance.md)
for lifecycle and accounting evidence. Forced refresh and multiple real account
partitions are not claimed by this single-account verification.
