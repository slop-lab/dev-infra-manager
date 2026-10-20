#!/usr/bin/env bash
set -euo pipefail
exec node -e 'require("node:http").createServer((req,res)=>res.end("hello-from-workspace\n")).listen(3000,"127.0.0.1")'
