# Examples

## Project

[`project/`](project/README.md) is the canonical, copyable DIM Project. It
demonstrates a reviewed root lifecycle repository together with ordinary
application and secret-service repositories, and is verified end to end.

## Feature examples

Feature examples isolate one capability in the smallest useful Project or
support process:

- [Managed CI runner](features/ci-runner/README.md)
- [External URLs](features/external-urls/README.md)
- [External URL route policy](features/external-url-route-policy/README.md)

If a broader integration example becomes useful, it should be added as
`all-in-one/` and exercise all major supported capabilities together. Special
one-off examples should otherwise remain under `features/`.
