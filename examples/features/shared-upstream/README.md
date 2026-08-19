# Feature example: several repositories in one upstream

DIM still manages `root` and `api` as separate Project repositories. Their
external Git connection points to one repository:

```text
root main       <-> upstream main
root v1         <-> upstream v1
api main        <-> upstream api/main
api v1          <-> upstream api/v1
```

The root is the explicit fallback. Refs matching another repository's prefix
are assigned first; remaining branch and tag refs belong to the fallback.
Unmatched refs are ignored when an upstream has no fallback.

```yaml
schemaVersion: 1
upstreams:
  product:
    url: https://github.com/example/product.git
repositories:
  root:
    upstream: product
    fallback: true
    root: true
    ref: main
  api:
    upstream: product
    refPrefix: api/
```

Prefixes must end in `/`, may not overlap, and an upstream may have at most
one fallback. A repository using `url` directly continues to synchronize with
its own external repository.

## Try it

```bash
bash create-repository.bash
bash register-project.bash
dim repo fetch shared-upstream-example api
dim repo push shared-upstream-example api \
  refs/heads/main:refs/heads/main
```

The ref names given to `repo push` are the logical refs in the managed
repository; DIM adds `api/` only at the external boundary. Commits are not
rewritten, so their object IDs remain unchanged.

Contributors can run the linked end-to-end verification locally or in a
disposable QEMU VM:

```bash
just verify example current-installed auto shared-upstream
just verify example runc use shared-upstream
```
