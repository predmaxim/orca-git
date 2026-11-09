# Drafts of issues for stablyai/orca

Not published. Each draft is meant for https://github.com/stablyai/orca/issues after review.

## 1. Plugin API: open a plugin's own view in an editor tab without a file

**Problem.** A plugin can contribute a panel (sidebar) and a custom editor (a tab for a file type), but it cannot open a tab of its own. The only way to get a full-size view next to the other editor tabs is `editor.open` on a file that matches the custom editor's `extensions`.

**What the Git Log plugin has to do today.** It writes an anchor file (`.orca-git-log.gitlog`) into the root of the user's repository, opens it with `editor.open`, and adds the file name to `.git/info/exclude` so it does not show up as untracked. This works, but:

- the plugin writes into the user's working directory and into `.git/info` only to get a tab;
- the file is visible in the file tree and in file search, and a stale anchor stays behind if the plugin is removed;
- every plugin with a tab-sized view would have to repeat the same workaround.

**Proposal.** An API such as `orca.editor.openView({ editor: 'log-tab', title, state })` (or a `contributes.tabs` entry plus `orca.tabs.open(id, params)`) that opens a custom editor tab that is not backed by a file. The tab would carry a title and an opaque JSON `state` that the frame can read, and would be restored after a restart like other tabs.

**Alternatives considered.** A virtual document URI scheme for custom editors (`plugin://<key>/<id>`) would also do.

## 2. Pass the active theme's syntax token colors to plugin frames

**Problem.** Orca themes define syntax colors (`tokenColors`), but a plugin frame only receives the UI variables (`--orca-*`) and the `light`/`dark` class. A plugin that shows code (a diff viewer, a blame view, a snippet panel) cannot color it like Orca's own editor and Orca's themes cannot restyle it.

**What the Git Log plugin has to do today.** It ships its own light and dark palettes in the style of WebStorm. The result does not follow the user's theme: a custom or third-party theme changes the whole UI except the code. Reading the theme file from disk is not an option for a plugin: it is Orca's internal state and not part of the plugin API.

**Proposal.** Give frames the token colors of the active theme, either as CSS variables set next to the `--orca-*` ones, for example `--orca-syntax-comment`, `--orca-syntax-keyword`, `--orca-syntax-string`, `--orca-syntax-number`, `--orca-syntax-function`, `--orca-syntax-type`, `--orca-syntax-variable`, `--orca-syntax-constant`, `--orca-syntax-operator`, `--orca-syntax-tag`, `--orca-syntax-attribute`, or as a `tokenColors` field in `FrameTheme` (scope list with foreground and font style) for plugins that map TextMate scopes themselves. The variables are simpler and cover most plugins; the field is more complete.
