FROM docker:29.1.3-dind

RUN apk add --no-cache bash busybox-extras curl jq tini
COPY start.sh /usr/local/bin/start-example-dev
COPY request-urls.bash /usr/local/bin/request-urls.bash

ENTRYPOINT ["/sbin/tini", "--", "sh", "/usr/local/bin/start-example-dev"]
