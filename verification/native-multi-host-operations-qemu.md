# QEMU 2대에서 네이티브 운영 검증하기

[2노드 운영 검증](native-multi-host-operations.md)의 두 SSH 대상을 별도 QEMU VM으로
준비할 수 있다. 이 방법은 물리 호스트에 DIM 서비스를 설치하기 전에 VM 경계와
노드 간 연결을 확인하는 용도다. 같은 물리 호스트의 VM 두 대는 별도 관리 주체나
물리 장비의 독립성을 증명하지 않는다.

이 문서는 QEMU 실행 예제다. OS 이미지, cloud-init seed, TLS, 비공개 역할 설정,
systemd unit을 자동 생성하지 않는다. 운영 게이트는 에이전트의
`/run/dim/qemu-verification` 서비스나 기존 privileged launcher를 사용하지 않는다.

## 1. 일회용 디스크와 로그인 준비

검토한 amd64 Ubuntu 24.04 cloud image를 고정된 digest로 검증하고, 운영자가 소유한
새 전용 디렉터리에 VM별 qcow2 디스크와 NoCloud seed를 준비한다. 기존 운영 디스크를
재사용하거나 원본 이미지에 직접 쓰지 않는다.

- A: control/QEMU 노드, 예시 4 vCPU, RAM 8 GiB, 디스크 48 GiB 이상
- B: ordinary 노드, 예시 4 vCPU, RAM 6 GiB, 디스크 32 GiB 이상
- 두 seed는 서로 다른 instance ID와 hostname을 사용해야 한다. 이미 부팅한 게스트를
  복사해 동일한 `/etc/machine-id`를 재사용하면 preflight가 거부한다.
- 두 VM에 `dim-operator` 계정과 운영자 공개 SSH 키를 등록한다. 개인 키는 운영자
  호스트에만 둔다. OS 준비에 필요한 guest sudo 권한도 운영자가 검토해 설정한다.

물리 호스트에는 QEMU와 접근 가능한 `/dev/kvm`, 위 VM 메모리 합계 외의 여유 자원이
필요하다. A에서 다시 KVM guest를 실행하므로 물리 호스트의 nested virtualization도
지원·설정되어 있어야 한다. TCG로 대체하지 않는다. guest A에서도 `/dev/kvm` 접근과
실제 KVM probe가 성공해야 한다.

## 2. 호스트에서 두 VM 실행

아래 경로는 모두 운영자가 미리 준비한 새 파일이다. `$LAB`과 디스크 경로에는 쉼표나
공백을 사용하지 않는다. SSH 22222/22223과 HTTPS 19443 포트가 비어 있는지 확인한다.
QEMU는 물리 호스트에서 일반 사용자로 실행하며 호스트 Docker socket을 전달하지 않는다.

```bash
LAB=/absolute/private/dim-qemu-lab
CONTROL_DISK="$LAB/control.qcow2"
ORDINARY_DISK="$LAB/ordinary.qcow2"
CONTROL_SEED="$LAB/control-seed.img"
ORDINARY_SEED="$LAB/ordinary-seed.img"
umask 077

qemu-system-x86_64 -enable-kvm -cpu host -machine q35 -smp 4 -m 8G \
  -display none -daemonize -pidfile "$LAB/control.pid" \
  -serial "file:$LAB/control-console.log" \
  -drive "file=$CONTROL_DISK,format=qcow2,if=virtio" \
  -drive "file=$CONTROL_SEED,format=raw,if=virtio,readonly=on" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:22222-:22,hostfwd=tcp:127.0.0.1:19443-:443 \
  -device virtio-net-pci,netdev=net0

qemu-system-x86_64 -enable-kvm -cpu host -machine q35 -smp 4 -m 6G \
  -display none -daemonize -pidfile "$LAB/ordinary.pid" \
  -serial "file:$LAB/ordinary-console.log" \
  -drive "file=$ORDINARY_DISK,format=qcow2,if=virtio" \
  -drive "file=$ORDINARY_SEED,format=raw,if=virtio,readonly=on" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:22223-:22 \
  -device virtio-net-pci,netdev=net0
```

운영자 호스트의 `~/.ssh/config`에 두 alias를 둔다.

```sshconfig
Host dim-control
    HostName 127.0.0.1
    Port 22222
    User dim-operator
    IdentityFile /absolute/private/dim-lab-ed25519
    IdentitiesOnly yes

Host dim-ordinary
    HostName 127.0.0.1
    Port 22223
    User dim-operator
    IdentityFile /absolute/private/dim-lab-ed25519
    IdentitiesOnly yes
```

첫 연결 전에 guest console 등 별도 경로로 SSH host-key fingerprint를 확인하고
`known_hosts`에 등록한다. host-key 검사를 끄지 않는다. 이후 다음 명령이 비대화형으로
성공해야 한다.

```bash
ssh -o BatchMode=yes dim-control true
ssh -o BatchMode=yes dim-ordinary true
```

## 3. B에서 A로 연결하기

각 user-mode NAT guest의 `10.0.2.15`는 서로 직접 연결되는 주소가 아니다. A의
HTTPS reverse proxy가 guest 443에서 제공되도록 준비하고, B에서는 호스트로 전달한
19443 포트를 통해 접근한다. 기본 QEMU user networking의 호스트 접근 주소는
`10.0.2.2`다.

예를 들어 B에서 `git.dim-lab.test`와 `ordinary.dim-lab.test`를 `10.0.2.2`로
해석하게 하고, ordinary host의 원격 endpoint를 각각
`https://git.dim-lab.test:19443`, `https://ordinary.dim-lab.test:19443`로 구성한다.
A의 reverse proxy는 두 TLS 이름을 해당 native Git/ordinary 중앙 서비스에 연결해야
한다. 인증서 SAN과 B의 신뢰할 CA를 맞추고 인증서 검증을 끄지 않는다. 고정 URL의
`/healthz`나 API 경로는 각 서비스 계약을 따른다.

A 내부의 importer 및 QEMU 연결은 계속 loopback endpoint를 사용한다. 이 예제는
QEMU host를 control plane과 별도인 세 번째 노드로 분리하는 설정이 아니다.
네트워크 방식이나 방화벽이 다르면 주소를 바꾸고, B에서 A의 올바른 인증서를 받는지
먼저 확인한다. [QEMU network 문서](https://www.qemu.org/docs/master/system/devices/net.html)의
user networking과 `hostfwd` 설명도 참고한다.

## 4. 같은 커밋 준비 후 게이트 실행

두 VM 모두 Sysbox, 정확한 host mirror plugin, Node/pnpm/Git, systemd 사용자 관리자와
링거링이 필요하다. A에는 추가로 실제 nested KVM과 Docker 29.1.4 이상의 `type=image`
지원이 필요하다. 29.1.3에서는 digest-pinned image mount가 경로 길이 결함으로 실패한다.
[운영 문서](native-multi-host-operations.md)에 따라 같은 검토된 소스·패키지,
비공개 역할 JSON과 inactive unit을 배치한다.

운영자 호스트에서는 예제 구성을 mode `0600`으로 복사해 실제 전체 SHA와 guest 내
경로를 채운다. `CONTROL_SSH=dim-control`, `ORDINARY_SSH=dim-ordinary`를 유지하고,
두 VM이 전용 일회용 노드임을 확인한 뒤 acknowledgment를 설정한다.

```bash
just verify native-multi-host-operations-preflight /absolute/operator/native-operations.conf
just verify native-multi-host-operations /absolute/operator/native-operations.conf
```

두 명령과 고정 command plan의 화면 출력을 mode-`0600` 로그에도 함께 남기려면 다음
래퍼를 대신 실행한다.

```bash
bash verification/scripts/run-native-multi-host-operations-with-log.bash \
  /absolute/operator/native-operations.conf
```

성공 증거는 운영자 호스트의 `EVIDENCE_DIR/OPS-PASSED`다. VM 부팅이나 SSH 성공만으로
검증을 통과한 것은 아니다. `125` 또는 marker 부재는 정리·검증 실패이며, journal을
수동 삭제해 숨기지 않는다.

증거와 필요한 데이터를 보관한 후 각 guest를 정상 종료하고 QEMU가 종료됐는지
확인한다. 디스크·seed 삭제는 운영자가 이 실험에 만든 파일에만 명시적으로 수행한다.
게이트는 control-plane/Project 상태를 남기며 기존 호스트 자원을 자동 삭제하지 않는다.
