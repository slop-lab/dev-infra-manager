# @slop-lab/git-blame

Runtime-neutral, bounded parsing for one-line Git `--line-porcelain` output.
The package validates immutable `{commit,path,line}` requests and returns a
validated `{commit,path,line,author,summary}` attribution.

```ts
import { parseGitBlameRequest, parseLinePorcelain } from "@slop-lab/git-blame";

const request = parseGitBlameRequest(input);
const attribution = parseLinePorcelain(porcelain, request);
```

Input is limited to 256 KiB and accepts complete SHA-1 or SHA-256 object IDs.
The caller owns bounded Git execution, repository access, commit reachability,
file/line existence, mailmap and text-conversion policy, HTTP, authentication,
and error translation. This package has no Git process, filesystem, service,
React, or DIM dependency.
