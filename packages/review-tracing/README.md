# Review tracing

`@slop-lab/dim-review-tracing` owns the language-neutral read broker, bounded read
manifest and comparison between protected and candidate Git snapshots. It does
not import the control plane, start an interpreter or execute repository code.

A runtime implements `ReviewTraceRuntime` and receives immutable repository read
callbacks. The orchestrator observes those callbacks itself: a runtime's returned
manifest is useful for diagnostics, but cannot erase observed reads. Code imports
and ordinary reads are dependencies. Explicit `readTargetFile(path, view)` reads
are predicate inputs, so a JSON predicate can protect selected fields without
protecting the entire JSON file. Reading the same file as a dependency and a
target keeps its dependency protection.

The candidate predicate always runs. The protected predicate also runs with the
same change metadata to discover prior dependencies; both of its target views
read the protected tree. Candidate target views read protected and candidate
snapshots respectively. Changed, missing, newly activated or demoted dependencies
require review independently of the candidate predicate's decision. A broken or
absent baseline requires review; a broken candidate prevents promotion.

This observes executed reads, not every possible future branch. A newly activated
read therefore requires review even when the dependency's bytes did not change.
The implementation revision, runtime revision, observations and comparison are
bound into review evidence and checked again before approval or promotion.

A runtime must isolate repository code from ambient filesystem, network and
process capabilities. Registering an arbitrary in-process function as a runtime
is trusted plugin code, not a sandbox. Language/runtime packages own that boundary;
this package owns no generic syscall monitor and makes no hostile-tenant claim.

Reads use normalized relative paths, record absent files, reject inconsistent
snapshots, and are limited to 512 distinct path/role/view requests, 1 MiB per file
and 16 MiB per evaluation. The Git adapter rejects symbolic links and nonregular
files before exposing bytes.

Discovery compares the two executions for the current proposal; it is not a
persisted history of dependencies. If a formerly dormant branch becomes reachable
in both executions, its files are compared between those two snapshots, but
earlier edits are not retroactively reviewed. Keep explicit path rules when every
potential dependency must be protected before any execution reaches it.
