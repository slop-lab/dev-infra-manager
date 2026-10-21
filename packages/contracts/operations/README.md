# Structured operations

`@slop-lab/dim-contracts-operations` describes named feature operations, their required access role, and input/output parsers. It owns no transport, service state, CLI or browser framework. Feature client packages own concrete operation definitions; service implementations enforce authorization before execution. `operationDescriptors` validates unique names for presentation without exposing parser internals.
