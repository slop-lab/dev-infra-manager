export function createOperationCoordinator() {
  let generation = 0;
  let controller = null;

  return {
    start() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      return { generation, signal: controller.signal };
    },
    isCurrent(operation) {
      return operation.generation === generation && operation.signal === controller?.signal && !operation.signal.aborted;
    }
  };
}
