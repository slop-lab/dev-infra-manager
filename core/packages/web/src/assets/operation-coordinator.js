// @ts-check
/** @typedef {{generation: number, signal: AbortSignal}} Operation */

export function createOperationCoordinator() {
  let generation = 0;
  /** @type {AbortController | null} */
  let controller = null;

  return {
    start() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      return { generation, signal: controller.signal };
    },
    /** @param {Operation} operation */
    isCurrent(operation) {
      return operation.generation === generation && operation.signal === controller?.signal && !operation.signal.aborted;
    }
  };
}
