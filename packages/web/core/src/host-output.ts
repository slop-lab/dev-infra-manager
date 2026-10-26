/** Finite budget for JSON emitted by an operator-selected host command.
 * Service responses can contain multi-megabyte diffs, then expand when the
 * host formats their JSON. This bounds both stdout and stderr independently.
 */
export const maximumHostOutputBytes = 32 * 1024 * 1024;
