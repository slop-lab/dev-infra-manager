# @slop-lab/gs-diff-service

Independent immutable real-Git diff composition over the neutral repository
read gate and reader ports. Callers inject a typed principal scope; the service
authorizes before and after object reads and asserts the repository target is
still current before returning. It has no DIM runtime, activation, transport,
credential, Project or review dependency.
