FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 AS build
RUN apk add --no-cache build-base busybox-static cpio linux-headers linux-virt
COPY guest-init /build/init
COPY guest-exit.c /build/guest-exit.c
COPY guest-exec.c /build/guest-exec.c
RUN cc -static -Os -s -o /build/guest-exit /build/guest-exit.c && \
    cc -static -Os -s -o /build/guest-exec /build/guest-exec.c && \
    mkdir -p /build/root/bin /build/root/dev /build/root/guest /build/root/lib /build/root/proc /build/root/sys && \
    cp /bin/busybox.static /build/root/bin/busybox && \
    cp -a /lib/modules /build/root/lib/ && \
    kernel_release="$(ls /build/root/lib/modules)" && \
    find /build/root/lib/modules -name '*.ko.gz' -exec gunzip {} + && \
    depmod -b /build/root "$kernel_release" && \
    cp /build/init /build/root/init && \
    cp /build/guest-exit /build/root/guest-exit && \
    cp /build/guest-exec /build/root/guest-exec && \
    chmod 0555 /build/root/init /build/root/guest-exit /build/root/guest-exec && \
    cd /build/root && find . -print0 | cpio --null -o --format=newc | gzip -9 > /build/initramfs.gz && \
    cp /boot/vmlinuz-virt /build/vmlinuz

FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
RUN apk add --no-cache qemu-system-x86_64
COPY --from=build /build/initramfs.gz /opt/dim/initramfs.gz
COPY --from=build /build/vmlinuz /opt/dim/vmlinuz
COPY dim-native-qemu-run /usr/local/bin/dim-native-qemu-run
RUN chmod 0444 /opt/dim/initramfs.gz /opt/dim/vmlinuz && \
    chmod 0555 /usr/local/bin/dim-native-qemu-run
