FROM docker:29.1.3-dind

RUN apk add --no-cache busybox-extras curl tini
COPY start.sh /usr/local/bin/start-example-dev

ENTRYPOINT ["/sbin/tini", "--", "sh", "/usr/local/bin/start-example-dev"]
