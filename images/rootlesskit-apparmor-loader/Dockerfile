FROM alpine:3.22

RUN apk add --no-cache apparmor bash

COPY scripts/install-rootlesskit-apparmor-profile-ubuntu.bash /usr/local/bin/

ENTRYPOINT ["bash", "/usr/local/bin/install-rootlesskit-apparmor-profile-ubuntu.bash"]
