FROM docker:29.1.3-dind@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5

RUN apk add --no-cache bash busybox-extras tini
COPY start.sh /usr/local/bin/start-example-dev

ENTRYPOINT ["/sbin/tini", "--", "sh", "/usr/local/bin/start-example-dev"]
