# DIM CI workflows

The default optional DIM workflow compiler reads candidate `.dim/ci/runner.yml`
(schema 4) and produces deterministic jobs for Sysbox and QEMU execution. It owns
YAML syntax, sections, job names and script declarations. Native Git receives a
compiler through its service composition and owns candidate object identities,
script hashes, trusted execution policy and reviewed Git changes.

The managed native Git service supplies `dimWorkflowCompiler`. Library users can
supply another compiler implementing the language-neutral `WorkflowCompiler`
interface exported by `@slop-lab/dim-native-git`.
