# OMP Web trial

The trial uses [jeffscottward/omp-web at a3b7447](https://github.com/jeffscottward/omp-web/tree/a3b744723eb9e73eb945c558d1d088d6bd6d2931).
Apply the checked-in patch from that checkout before building:

```sh
git apply /path/to/dev-infra-manager/tools/omp-web/patches/0001-join-acp-message-chunks.patch
npm ci
npm run build
```

Consecutive ACP text chunks stay in one Markdown block in both completed turns
and replayed history. Thoughts and other content retain their own blocks. Verify
by sending a prompt in the browser and checking the complete answer in one
rendered block before reopening the same session.
