# @slop-lab/gs-review-tracing

Runtime-neutral read brokering and dependency evidence for repository review
predicates. The package receives exact protected and candidate snapshot readers;
it does not import DIM, register plugins, access repositories or execute detector
code. Runtime registration belongs to the embedding application.

`ReviewTraceRuntime` is exported from `@slop-lab/gs-review-tracing/plugin-api`.
The broker observes all dependency and target reads itself, bounds them, and
binds the runtime revision, observations and comparisons into evidence. The
stored `dim-review-tracing-v1` digest domain remains stable for existing data.

The candidate predicate always runs. The protected predicate also runs to
discover prior dependencies. Both target views use the protected tree during
that baseline execution; candidate target views distinguish protected and
candidate snapshots. Changed, missing, newly activated or demoted dependencies
require review independently of the candidate predicate's decision. A broken or
absent baseline requires review, while a broken candidate fails closed.

Reads use normalized repository-relative paths, record absent files, reject
inconsistent snapshots, and are limited to 512 distinct path/role/view requests,
1 MiB per file and 16 MiB per evaluation. Repository adapters remain responsible
for rejecting symbolic links and nonregular files before exposing bytes.
