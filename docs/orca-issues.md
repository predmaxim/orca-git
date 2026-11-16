# Drafts of issues for stablyai/orca

Published 2026-11-11 (by the user's decision): 1 as a comment on stablyai/orca#19826 ("Let plugin panels render in the workspace area", which it overlaps): https://github.com/stablyai/orca/issues/19826#issuecomment-6780278191; 2 as stablyai/orca#40879; a third, on a terminal's busy state and unsaved editor tabs (backlog item 15), as stablyai/orca#40880. Earlier: stablyai/orca#40813 (moving focus between the plugin's tab and panel).

Published 2026-11-16 (by the user's decision): stablyai/orca#43189, plugin workers get no session environment (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`), so git credential helpers on the session bus fail. The plugin's workaround is `sessionRuntimeDir` in `src/worker/launch.ts` (marked `shortcut:`); remove it, its test `src/worker/sessionenv.test.ts` and the sentences in the README and `docs/git-safety.md` once Orca passes the variables.

## 1. Plugin API: open a plugin's own view in an editor tab without a file

**Problem.** A plugin can contribute a panel (sidebar) and a custom editor (a tab for a file type), but it cannot open a tab of its own. The only way to get a full-size view next to the other editor tabs is `editor.open` on a file that matches the custom editor's `extensions`.

**What the Git Log plugin has to do today.** It writes an anchor file (`.orca-git-log.gitdiff`) into the root of the user's workspace, opens it with `editor.open`, and adds the file name to `.git/info/exclude` so it does not show up as untracked. This works, but:

- the plugin writes into the user's working directory and into `.git/info` only to get a tab;
- the file is visible in the file tree and in file search, and a stale anchor stays behind if the plugin is removed;
- every plugin with a tab-sized view would have to repeat the same workaround.

**Proposal.** An API such as `orca.editor.openView({ editor: 'diff-tab', title, state })` (or a `contributes.tabs` entry plus `orca.tabs.open(id, params)`) that opens a custom editor tab that is not backed by a file. The tab would carry a title and an opaque JSON `state` that the frame can read, and would be restored after a restart like other tabs.

**Alternatives considered.** A virtual document URI scheme for custom editors (`plugin://<key>/<id>`) would also do.

## 2. Pass the active theme's syntax token colors to plugin frames

**Problem.** Orca themes define syntax colors (`tokenColors`), but a plugin frame only receives the UI variables (`--orca-*`) and the `light`/`dark` class. A plugin that shows code (a diff viewer, a blame view, a snippet panel) cannot color it like Orca's own editor and Orca's themes cannot restyle it.

**What the Git Log plugin has to do today.** It ships its own light and dark palettes in the style of WebStorm. The result does not follow the user's theme: a custom or third-party theme changes the whole UI except the code. Reading the theme file from disk is not an option for a plugin: it is Orca's internal state and not part of the plugin API.

**Proposal.** Give frames the token colors of the active theme, either as CSS variables set next to the `--orca-*` ones, for example `--orca-syntax-comment`, `--orca-syntax-keyword`, `--orca-syntax-string`, `--orca-syntax-number`, `--orca-syntax-function`, `--orca-syntax-type`, `--orca-syntax-variable`, `--orca-syntax-constant`, `--orca-syntax-operator`, `--orca-syntax-tag`, `--orca-syntax-attribute`, or as a `tokenColors` field in `FrameTheme` (scope list with foreground and font style) for plugins that map TextMate scopes themselves. The variables are simpler and cover most plugins; the field is more complete.

## 3. Plugin API: launch an agent the way the new-agent menu does, and send text to an open chat

Draft, 2026-11-15, not published (the user's decision: write it down, publish later). Checked against Orca 1.4.258's bundle; no duplicate found by `gh search issues` for agent launch, chat send or the agent list in plugins. Related: #34029, #40320 and #37701 (launching as a chat elsewhere), #36236 (a model per launch).

**Problem.** A plugin that hands work to an agent cannot do what Orca's own "send notes" menu does. In the plugin host API:

- `agent.launch` takes `{ workspaceId, agent, prompt }` and always starts the agent's CLI in a terminal. It cannot start it as a chat, and cannot pick a model or a reasoning effort. The `orca agent launch` CLI can (`--surface chat|terminal`, `--model`, `--effort`), and so can the new-agent menu.
- There is no way to list the agents the user can launch (detected, enabled, the default one, which surfaces each supports). `agents.list` returns only running agents.
- A plugin cannot send text to an open chat. `terminal.sendText` reaches only terminals of the active worktree, and a chat has no terminal id (`agents.list` would give `terminalId: null`). Orca's notes menu delivers to chats with `agentSession.send`.

**What the Git Log plugin needs it for.** It will let the user leave review notes on a commit selection in its Diff tab and send them to an agent, the way Orca's diff notes do. Today it can offer only terminal agents of the active worktree and a new terminal agent, with Orca's defaults; the user's chats and the model they want for a review are out of reach.

**Proposal.**

1. `agent.launch` accepts `surface?: 'chat' | 'terminal'` (default: the user's Chat | CLI setting for that agent), `model?` and `effort?`, as `orca agent launch` does.
2. A host method such as `agents.available` that returns what the new-agent menu shows: each agent's id, name, whether it is enabled and detected on the workspace host, its surfaces, and which one is the default.
3. `agents.list` includes chat sessions with a `sessionId`, and a method such as `agent.send({ terminalId } | { sessionId }, text)` that delivers text the way the notes menu does (waits until the agent is idle). It could sit under a capability like `agent:send`.

**Alternatives considered.** A plugin's trusted worker can run the `orca agent launch` CLI itself, but that goes around the plugin API and its capabilities, and has no way to reach an existing chat.
