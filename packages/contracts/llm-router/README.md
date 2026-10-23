# LLM router contracts

`@slop-lab/dim-contracts-llm-router` owns operation inputs, validated outputs,
access descriptions and router wire schemas. Service and consumer implementations
share this contract without depending on each other. It contains no HTTP client,
credential-file access, provider implementation or router state.
