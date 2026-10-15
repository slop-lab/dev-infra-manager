# 네이티브 2노드 운영 검증

이 문서는 프리스테이블 설치 전에 운영자가 실행할 수 있도록
`native-multi-host-operations` 프로필을 준비하는 절차다. 자동 프로비저너가
아니다. 두 노드의 운영체제, 계정, TLS, 리버스 프록시, 비공개 JSON 역할 파일,
systemd 사용자 서비스는 운영자가 먼저 준비해야 한다.

성공 결과는 두 실제 실행 종류의 제한된 운영 증거다. 안정 버전의 전체 인수,
사람의 승인, 보호 ref 승격을 뜻하지 않는다.

## 토폴로지

일회용 QEMU VM 두 대를 사용하려면 [QEMU 실행 예제](native-multi-host-operations-qemu.md)를
먼저 따른다. VM 준비 후에는 이 문서와 같은 운영 게이트를 실행한다.

운영자 호스트 또는 노드 A에서 게이트를 실행한다. `CONTROL_SSH`와
`ORDINARY_SSH`는 서로 다른 깨끗한 일회용 Linux 노드를 가리켜야 한다.

| 노드 | 역할 |
| --- | --- |
| A, control | 네이티브 Git, ordinary 중앙 서비스, 권장 Sysbox workspace, QEMU scheduler, 실제 KVM 용량 |
| B, ordinary | `sysbox-runc`를 사용하는 ordinary host |

노드 A에서 QEMU scheduler와 QEMU host 사이의 연결은 loopback으로 유지한다.
노드 B의 ordinary host가 노드 A의 중앙 서비스와 네이티브 Git에 보내는 트래픽은
운영자가 준비한 검증 가능한 HTTPS를 사용해야 한다. 신뢰할 CA, 서버 인증서,
리버스 프록시와 방화벽은 게이트가 만들지 않는다.

노드의 machine ID, boot ID, Docker daemon 분리는 두 실행 환경이 서로 다름을
보여 주지만 물리적 분리나 관리 주체의 독립성을 증명하지 않는다.

## 사전 조건

두 노드 모두 다음 조건을 만족해야 한다.

- 검토한 같은 전체 커밋의 깨끗한 checkout
- Docker 29, Compose v2, Buildx와 `type=image` 출력 지원
- 등록된 `sysbox-runc`와 설치한 정확한 버전의 host mirror plugin
- `/usr/bin/git` 2.43.0, Node.js 24 또는 26, pnpm 10.13.1
- systemd 사용자 관리자와 로그인 세션 밖에서도 서비스를 유지할 user lingering
- 운영자 계정이 소유하는 절대 경로, 공백이나 셸 메타 문자가 없는 원격 구성 경로
- 기존 DIM Project, 저장소, 서비스, 컨테이너, 볼륨, 상태를 채택하거나 삭제하지 않을 일회용 노드

두 노드 모두 Sysbox가 필요하다. 노드 A는 lifecycle 파일이 없는 fixture의 권장
workspace를 만들고, 노드 B는 ordinary job을 실행한다. 노드 A에는 추가로 읽고 쓸
수 있으며 실제로 동작하는 `/dev/kvm`이 필요하다. 두 노드는 다른 작업과 용량을
공유하면 안 된다.

이 프로필은 운영체제 패키지를 설치하지 않는다. TLS나 비공개 JSON 자격 증명을
생성하지 않고 systemd unit도 만들지 않는다. 필요한 unit은 아래 예처럼 운영자가
먼저 작성하되, 게이트를 시작하기 전에는 모두 inactive 상태로 둔다. 기존 데이터를
마이그레이션하거나 삭제하는 기능도 없다.

에이전트 checkout의 `.dim/setup.sh`를 물리 호스트에서 `sudo`로 실행하지 않는다.
에이전트용 `/run/dim/qemu-verification` 소켓도 이 프로필에 쓰지 않는다. 제거된
`--repos` 입력은 사용하지 않는다.

## 같은 소스와 패키지 준비

`EXPECTED_COMMIT`에는 새 게이트와 runner를 포함해 검토한 전체 커밋을 넣는다.
운영자가 검토, commit, 배포를 끝낸 뒤 그 전체 SHA를 선택한다.

두 노드의 깨끗한 checkout에서 각각 다음 명령을 실행한다.

```bash
DIM_SOURCE_ROOT_COMMIT=REPLACE_WITH_FULL_REVIEWED_COMMIT just prepare-local
```

각 노드의 `.local/prepared-local.state`에서 `root`,
`aggregate-lock-sha256`, `packages.sha256`, `image.ref`, `image.id`를 보관한다.
게이트는 source commit, aggregate lock, package aggregate와 prepared image ref가
두 노드에서 같은지 비교한다. 각 노드가 독립적으로 Docker image를 빌드하므로 build
timestamp에 따라 정상적인 `image.id`는 서로 다를 수 있다. 게이트는 두 ID를 각각
검증하고 증거에 기록하며, ID 동일성을 요구하지 않는다. 차이를 감추기 위해 준비
metadata를 수동으로 다시 쓰면 안 된다. 이 명령이 만드는 준비 산출물 외에 별도
bundle 형식을 가정하지 않는다.

ordinary와 QEMU의 runner 및 job image는 별도 문제다. 비공개 host/scheduler 구성의
operator capacity에는 검토한 digest-pinned image를 고정해야 하며, candidate나
준비 metadata가 이를 바꾸지 않는다.

게이트는 준비된 로컬 패키지로 설치한다. OS 의존성, TLS, 비공개 JSON 역할 파일,
systemd unit은 설치하지 않는다.

## Project fixture

노드 A의 `PROJECT_SOURCE`에는
[`examples/projects/native-basic-root`](../examples/projects/native-basic-root/README.md)를
복사해 별도의 깨끗한 로컬 Git 저장소로 만들고, 검토한 커밋을 생성한다.
`PROJECT_COMMIT`에는 그 전체 SHA를 넣는다. fixture에는 다음 항목이 모두 있어야 한다.

- `.dim/ci/runner.yml`의 ordinary `source` job과 QEMU `integration` job
- `.dim/repos.yml` 정책의 필수 ordinary `source`와 QEMU `integration`
- `source.bash`가 stdout에만 출력하는 `native-basic-ordinary-ok`
- `integration.bash`가 stdout에만 출력하는 `native-basic-qemu-ok`
- 비밀이 없는 깨끗하고 고정된 로컬 root commit

이 fixture에는 custom lifecycle 파일이 없으므로 노드 A는 권장 agent workspace를
만들고 checkout을 `/workspace`에 둔다. 따라서 예제의 `WORKSPACE_REPOSITORY`도
`/workspace`여야 한다.

fixture를 수정했다면 이름과 marker를 추측하지 말고 다음처럼 확인한 뒤 구성의
`ORDINARY_JOB`, `QEMU_JOB`, `ORDINARY_MARKER`, `QEMU_MARKER`를 실제 값에 맞춘다.

```bash
sed -n '1,160p' "$PROJECT_SOURCE/.dim/ci/runner.yml"
sed -n '1,160p' "$PROJECT_SOURCE/.dim/ci/jobs/source.bash"
sed -n '1,160p' "$PROJECT_SOURCE/.dim/ci/jobs/integration.bash"
sed -n '1,160p' "$PROJECT_SOURCE/.dim/repos.yml"
```

## 비공개 파일 배치

모든 파일은 해당 DIM 운영자 계정이 소유하는 일반 파일이어야 한다. mode는
`0600`, link count는 1이어야 하며 symlink는 허용하지 않는다. 완전한 JSON을 이
문서에서 새로 만들지 말고 설치 및 서비스 스키마를 따른다.

| 파일 | 노드 | 계약 |
| --- | --- | --- |
| `CONTROL_INSTALL_CONFIG` | A | [control-plane bundle 설치 구성](../specification/specs/14-installer-facade.md#control-plane-bundle) |
| `REGISTRAR_CONNECTION` | A | [네이티브 등록 역할](../specification/specs/local-details/native-git-transport.md#scope) |
| `IMPORTER_CONNECTION` | A | [네이티브 root importer 역할](../specification/specs/03-configuration.md#native-selection) |
| `CONTROL_PLANE_CONNECTION` | A | [Project와 workspace 네이티브 선택](../specification/specs/03-configuration.md#native-selection) |
| `QEMU_SCHEDULER_CONFIG` | A | [QEMU scheduler schema 2](../specification/specs/local-details/native-qemu.md#operator-deployment-contract) |
| `QEMU_HOST_CONFIG` | A | [QEMU host connection](../specification/specs/local-details/native-qemu.md#operator-deployment-contract) |
| `ORDINARY_HOST_CONFIG` | B | [global ordinary CI 계약](../specification/specs/03-configuration.md#global-ci) |

현재 native Project importer 구성은 노드 A의 loopback endpoint만 사용한다.
`IMPORTER_CONNECTION`을 B로 복사하거나 원격 importer 경로로 바꾸지 않는다.
Registrar와 control-plane 연결도 역할별 파일로 분리한다. reviewer, promoter,
일반 관리자 자격 증명은 이 프로필의 입력이 아니다.

`ORDINARY_STATE_DIRECTORY`는 `ORDINARY_HOST_CONFIG` JSON의 `stateDirectory`와
정확히 같아야 한다. 다른 빈 디렉터리를 지정해 실제 journal 검사를 건너뛰는 구성은
preflight에서 거부한다.

## systemd 사용자 unit 예

아래 예는 운영자 계정이 `dim-operator`이고 설치 경로가
`/home/dim-operator/.local/share/dim/runtime/current`인 경우다. 실제 절대 경로가
다르면 unit을 만들기 전에 바꾼다. `ExecStart`에 `dim` 같은 PATH 의존 명령이나
상대 경로를 쓰지 않는다.

노드 B의 `~/.config/systemd/user/dim-native-root-host.service`:

```ini
[Unit]
Description=DIM native ordinary host

[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dim-operator/.local/share/dim/runtime/current/node_modules/.bin/dim ci native-root host run /srv/dim-operator/ordinary-host.json
Restart=on-failure

[Install]
WantedBy=default.target
```

노드 A의 `~/.config/systemd/user/dim-native-qemu-scheduler.service`:

```ini
[Unit]
Description=DIM native QEMU scheduler

[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dim-operator/.local/share/dim/runtime/current/node_modules/.bin/dim ci native-qemu scheduler run /srv/dim-operator/qemu-scheduler.json
Restart=on-failure

[Install]
WantedBy=default.target
```

노드 A의 `~/.config/systemd/user/dim-native-qemu-host.service`:

```ini
[Unit]
Description=DIM native QEMU host
After=dim-native-qemu-scheduler.service

[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dim-operator/.local/share/dim/runtime/current/node_modules/.bin/dim ci native-qemu host run qemu-a /srv/dim-operator/qemu-host.json
Restart=on-failure

[Install]
WantedBy=default.target
```

각 노드에서 관리자가 운영자 계정에 `loginctl enable-linger dim-operator`를 적용하고,
그 계정의 정상 로그인 세션에서 `systemctl --user`가 동작하는지 확인한다. root의
user manager나 임의로 만든 `XDG_RUNTIME_DIR`를 대신 쓰지 않는다. unit을 배치한
뒤에는 노드별로 다음 명령을 실행한다. 오류를 숨기지 않는다.

노드 B:

```bash
systemctl --user daemon-reload
systemctl --user disable --now dim-native-root-host.service
systemctl --user show --property=ActiveState --value dim-native-root-host.service
```

마지막 명령의 출력은 `inactive`여야 한다. 노드 A:

```bash
systemctl --user daemon-reload
systemctl --user disable --now dim-native-qemu-scheduler.service
systemctl --user disable --now dim-native-qemu-host.service
systemctl --user show --property=ActiveState --value dim-native-qemu-scheduler.service
systemctl --user show --property=ActiveState --value dim-native-qemu-host.service
```

마지막 두 명령의 출력은 모두 `inactive`여야 한다. 게이트 전에는 세 unit 모두
inactive 상태여야 한다.

## 구성 작성과 preflight

운영자 호스트의 저장소에서 예제를 복사한다.

```bash
install -m 0600 verification/native-multi-host-operations.conf.example \
  /absolute/operator/native-multi-host-operations.conf
```

두 개의 all-zero SHA를 실제 전체 SHA로 바꾼다. 모든 경로와 SSH 대상을 확인한다.
두 노드가 정말 일회용이며 이 실행에 독점되었음을 확인한 뒤 마지막으로
`DISPOSABLE_EXCLUSIVE_NODES_ACK` 값을 정확히
`control-qemu-and-ordinary`로 바꾼다. 예제의 `UNCONFIRMED`는 의도적으로
preflight를 실패시킨다.

runner의 입력 계약과 고정 명령 계획을 먼저 확인한다.

```bash
bash verification/scripts/native-multi-host-operations.bash --help
bash verification/scripts/native-multi-host-operations.bash --print-command-plan
just verify native-multi-host-operations-preflight \
  /absolute/operator/native-multi-host-operations.conf
```

`--print-command-plan`은 실행 권한을 주는 단계가 아니다. 새 workspace 안에서 두
개의 일회용 candidate commit을 만들고 proposal ref로 push하는 것은 예상된 동작이다.
보호 ref 쓰기, promotion, 사람의 승인, 임의 host 자원 삭제, OS 설치가 계획에
나타나면 실행하지 않는다.

## 실행과 결과

preflight가 성공한 같은 절대 구성 경로로 기본 실행을 시작한다.

```bash
just verify native-multi-host-operations \
  /absolute/operator/native-multi-host-operations.conf
```

성공하면 `EVIDENCE_DIR/OPS-PASSED`는 JSON schema 1이며 `result`는
`operations-passed`, `scope`는
`prestable-two-node-control-qemu-plus-ordinary-operations`다. marker와 증거를
함께 보관한다.
이 결과의 범위는 다음 항목으로 제한된다.

- ordinary Sysbox job과 QEMU KVM job이 idle unit process restart 전후에 실제 성공
- 두 결과의 job 이름과 stdout marker가 구성과 일치
- 실행 전후 보호 ref가 변경되지 않음
- 구성한 claim이 정리되고 테스트 workspace가 정리됨

`OPS-PASSED`가 없거나 schema, result, scope가 다르면 성공으로 기록하지 않는다.
로그와 증거에는 비밀 값이 없어야 한다. 운영자 role 파일 자체는 evidence에
복사하지 않는다.

worker 정지 직후에도 구성된 journal과 작업 디렉터리를 다시 검사한다. 정지 시점에
claim 요청 journal 등이 남으면 보수적으로 `125`를 반환하고 성공 marker를 만들지
않는다. 이는 정리 완료를 확인하지 못했다는 뜻이다. 증거를 보존하고 서비스의
정상 복구 경로를 확인해야 하며, 통과시키려고 journal이나 컨테이너를 수동 삭제하면
안 된다. 이 프로필을 준비하기 위해 제품의 shutdown 동작을 바꾸지는 않았다.

## 검증하지 않는 범위

이 프로필은 다음을 검증하지 않는다.

- 사람의 승인 또는 checked compare-and-swap 승격
- host reboot, 실행 중 crash, 실패 결과, stale 결과, replay 전체 행렬
- 실제 트래픽 캡처에 기반한 권한 검사 또는 guest 내부 권한 검사
- 물리 노드 분리, 별도 관리 주체, 관리 권한 독립성
- 프리스테이블 범위를 넘는 전체 안정 버전 인수

따라서 이 결과를 `VERIFICATION-NATIVE-CUTOVER-001` 충족이나 출시 승인으로
표현하면 안 된다.
