# Preserved issue implementation

This work implements the 32 open `dim-dim/root` issues and their comments exported
on 2026-10-18. The stopped `dim-gitea` database was copied read-only and compared:
all 32 issues and 80 comments match the preserved backup, whose checksums pass.
The original backup and attachment remain unchanged outside the repository.

Optional features belong to plugins. Base workspace lifecycle and narrow typed
extension ports belong to core; host composition and SSH dispatch belong to CLI.
Prior progress comments are evidence to check, not acceptance. A source test does
not establish actual KVM, account authentication, or deployed service behavior.

| Issue | Requested outcome | Implementation / acceptance |
| --- | --- | --- |
| #1 | local cache를 거치지 않는 docker hub pull 감지? | Audit in progress |
| #3 | CI 이미지 캐시 | Audit in progress |
| #4 | codex helper 및 example, 연계 검증 추가 | Audit in progress |
| #6 | 개발환경 설정 편의성 개선 및 관련 방향성 변경 | Audit in progress |
| #8 | 오류 메시지 내용로 오류가 어떤 단계에서 발생했는지 알 수 있도록 수정 | Audit in progress |
| #11 | controller, gitea 재시작 시 workspace에서 dim-gitea 호스트를 못 찾음 | Audit in progress |
| #15 | example workspace restart 등 검증 추가 | Audit in progress |
| #22 | 자체 워크스페이스 재생성 기능 추가 | Audit in progress |
| #24 | VM 기반 workspace backend 추가 | Audit in progress |
| #27 | 프로젝트별 ci runner 이미지 필요하지 않도록 수정 | Audit in progress |
| #29 | opencode 설정 툴 external-url slug opencode로 고정 | Audit in progress |
| #31 | opencode 사용하도록 설정된 repo에 프로젝트와 무관한 opencode 설정 없어야 함 | Audit in progress |
| #32 | opencode 임시 작업물이 컨테이너 안에서 /tmp 경로에 들어가지 않도록 설정 변경 | Audit in progress |
| #34 | 테스트에서 파일 간 병렬 실행을 cpu 코어 수에 따라 조정할 수 있도록 하는 nproc 추가 | Audit in progress |
| #35 | docker/apt registry mirror 플러그인 추가/분리 및 대체, 추가 확장 기반 및 방향성 확립 | Audit in progress |
| #37 | 시스템 리소스 제한 변경 | Audit in progress |
| #38 | dim 없는 프로젝트 사용 가능하게 수정 | Audit in progress |
| #39 | 간단한 웹 서버를 external-urls 플러그인을 통해 expose하는 기능 적절한 example에 추가 | Audit in progress |
| #40 | core에서 gitea 제거, control plane 자체 git host 구현 | Audit in progress |
| #41 | web ui 추가(별도 패키지, #40 이후) | Audit in progress |
| #44 | 에이전트 컨테이너 내부에 workspace backend 중립 dim 공통 인터페이스 제공 | Audit in progress |
| #45 | dim installer facade 동작 변경 | Audit in progress |
| #47 | .dim 수정 시 workspace 재시작 등의 동작을 간단히 테스트할 방법 추가 | Audit in progress |
| #48 | self workspace restart 등의 api를 통해 workspace만 재시작하는 게 아니라 에이전트 세션도 이어서 진행할 수 있어야 함 | Audit in progress |
| #49 | rootlesskit 아래의 좀비 containerd-shim 프로세스 누수 | Audit in progress |
| #50 | opencode web 헬퍼 스크립트 cors origin 변경 | Audit in progress |
| #51 | 호스트 llm api router 플러그인 추가 | Audit in progress |
| #52 | external-urls AI 에이전트가 사용하기 좋게 문서화 | Audit in progress |
| #53 | persist VM 플러그인 및 웹 ip-KVM 추가 | Audit in progress |
| #54 | 터널 플러그인 추가 | Audit in progress |
| #55 | controller 및 web ui server를 oom killer로부터 보호 | Audit in progress |
| #56 | 기본 에이전트 이미지에 docker buildx 등 의존성 보강 설치 | Audit in progress |
