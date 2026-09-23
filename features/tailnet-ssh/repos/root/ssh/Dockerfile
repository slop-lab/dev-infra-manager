FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

RUN apk add --no-cache openssh-server \
 && adduser -D -s /bin/ash developer \
 && passwd -d developer \
 && install -d -o developer -g developer -m 0700 /home/developer/.ssh /var/lib/ssh-host-keys
COPY authorized_keys /home/developer/.ssh/authorized_keys
COPY start-sshd.sh /usr/local/bin/start-sshd
RUN chown developer:developer /home/developer/.ssh/authorized_keys \
 && chmod 0600 /home/developer/.ssh/authorized_keys \
 && chmod 0755 /usr/local/bin/start-sshd

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/start-sshd"]
