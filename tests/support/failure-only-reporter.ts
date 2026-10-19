import { DefaultReporter } from "vitest/reporters";

/** Keep Vitest's failure diagnostics, failed-test logs and final counts. */
export class FailureOnlyReporter extends DefaultReporter {
  constructor() { super({ summary: false, isTTY: false }); }
  // DefaultReporter still handles failed hooks/modules and renders their full
  // native diffs/stacks in its final summary. Skip individual module/test rows.
  protected override printTestModule(): void {}
}
