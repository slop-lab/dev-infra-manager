# @slop-lab/react-git-diff

Controlled React diff presentation, independent of DIM, network clients and
authentication. Receives a `DiffSnapshot` from `@slop-lab/git-diff` or a service.

```ts
import { GitDiff, mountGitDiff } from '@slop-lab/react-git-diff';
const view = mountGitDiff(container, {
  snapshot,
  onSelectLine(anchor) { selectCommentAnchor(anchor); },
  renderFileToolbar({ file }) { return renderBlameButton(file); },
  renderLineGutter(context) { return renderCommentCount(context); },
  renderBelowLine(context) { return renderCommentThread(context); }
});
// view.update(nextProps); view.unmount();
```

The three explicit slots receive file or line context. Line context contains
both base and head anchors; deletion lines have no head anchor, additions no
base anchor. The caller owns comment state, authorization, loading and revision
selection. React escapes file paths, source text and hunk headers; the component
never renders supplied HTML. Each line number is a keyboard-accessible selection
button when `onSelectLine` is provided. File sections and tables have accessible
names. Load the optional default stylesheet with
`import "@slop-lab/react-git-diff/styles.css"`, or provide your own CSS for the
semantic `git-diff` classes. No inline styles are emitted, so strict
`style-src 'self'` CSP works. `className` is appended to the root class.
The stylesheet can also be served as an ordinary CSS asset without a bundler.

React and React DOM are peer dependencies. Bundle this ESM package with your
application; no DIM runtime or service is required.
