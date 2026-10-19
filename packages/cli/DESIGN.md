# DIM CLI Terminal Design System

## 1. Atmosphere & Identity

DIM is a quiet, precise operator tool. Its terminal UI prioritizes trustworthy
state, stable machine output, and immediate recovery over decoration. The
signature is transient status that yields completely to command output.

## 2. Color

DIM does not add terminal color. Progress inherits the terminal foreground and
background so it remains legible in user-selected light, dark, and high-contrast
themes. Status meaning is carried by words, never color alone.

## 3. Typography

The terminal's monospace font and cell metrics are authoritative. Visible status
uses sentence case. Core lifecycle stage labels retain their exact spelling and
capitalization. No icon font or Unicode-only symbol is required.

## 4. Spacing & Layout

Progress uses one terminal row for the current operation and, when known, one
row for remaining lifecycle work. Both rows must fit the active terminal width.
Stream output begins where the cleared progress block began, without blank rows,
wrapped remnants, or cursor drift.

## 5. Components

### Idle Progress

- **Structure**: ASCII spinner, current stage, optional remaining-stage row.
- **Variants**: operation-only; workspace lifecycle stage with remaining work.
- **States**: delayed, visible, updated, cleared for stream output, stopped.
- **Accessibility**: plain text, no color dependency, no rapid layout movement.
- **Motion**: four ASCII frames at the existing interval after five idle seconds.
- **Layout**: at most two width-bounded terminal rows.

### Machine Output

- **Structure**: original stdout and stderr bytes.
- **Variants**: redirected streams, JSON stdout, interactive raw terminal.
- **States**: byte-identical in every state.
- **Accessibility**: no terminal-control bytes are added outside TTY progress.
- **Motion**: none.
- **Layout**: producer-owned.

## 6. Motion & Interaction

Motion communicates only that an accepted operation is still active. A stage
event resets the idle delay and updates semantic status without printing a
persistent line. Any stdout or stderr payload clears progress before its first
byte. Result, failure, disconnect, cancellation, and SIGINT clear progress and
cancel timers. Interactive `exec` and `run` never render progress.

## 7. Depth & Surface

The terminal is the only surface. Hierarchy uses two text rows and indentation,
not borders, shadows, color, or decorative glyphs. `Current:` and `Remaining:`
are the stable labels.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Preserve arbitrary terminal themes and monospace cell widths.
- Keep every rendered row within the reported terminal columns.
- Preserve wide-character stream output without rewriting or measuring it.
- Never expose command arguments, environment values, credentials, or arbitrary
  controller text through progress.
- Keep non-TTY stdout, JSON stdout, and stderr byte-identical.

### Accepted Debt

None.
