# Git for Orca

![Git sidebar with six selected commits and their files on the right, the Diff tab with one of the files on the left](images/git-dark.png)

## About this fork

This is a fork of [emamalet/Orca-git-log-panel](https://github.com/emamalet/Orca-git-log-panel) that reshapes the interface after the WebStorm Git tool window: a sidebar with a branches tree, the commit list and the files of a multi-commit selection, and a Diff tab for the file you click. The Git engine (`src/worker`) is kept as close to upstream as possible. The design is in [docs/superpowers](docs/superpowers) and the engine review in [docs/engine-review.md](docs/engine-review.md).

To pull in upstream changes:

```sh
git fetch upstream && git log --oneline main..upstream/main
```

Then bring over what you need with `git cherry-pick` or `git merge upstream/main`. Pull requests are not sent to upstream.

An [Orca](https://www.onorca.dev) plugin that adds a WebStorm-style **Git** view to Orca: a branch tree, a
colored commit graph, the files changed by a whole multi-commit selection, a syntax-highlighted diff in an
editor tab, and a right-click menu to rewrite history. The interface follows Orca's language (English and Russian).

![Diff tab: a side-by-side diff of a TypeScript file with syntax highlighting](images/diff-dark.png)

![Branch tree grouped into folders](images/branches-dark.png)

## Features

- **Sections**: Branches, Commits, Files and Details stack in a column, like the WebStorm Git tool window. Click
  a header to collapse a section to one line with its summary (current branch, number of selected
  commits); drag the line between open sections to resize them. The layout is remembered.
- **Commit graph**: colored lanes, merges, ref labels (`origin & main`, tags, HEAD), commits not
  reachable from HEAD are dimmed.
- **Filters**: text or hash (with regex `.*` and match case `Cc`), Branch, User, Date and Paths.
- **Branch tree**: HEAD, Local, Remote and Tags, with branches grouped into folders by prefix (`feature/`,
  `fix/`); search by name. Click a branch to filter the log by it (click again to clear), double-click
  to jump to its commit. Right-click for checkout, new branch from it, rename,
  delete (local only; an unmerged branch asks first), merge into the current branch and rebase the
  current branch onto it.
- **Files of the selection**: the changed files of all selected commits as a folder tree with status
  letters (added, modified, deleted, renamed), expand/collapse all. For each file the diff runs from its
  state before the earliest selected commit that touched it to its state after the latest one, so a
  selection across a merge works too. A click (or Enter) opens the file's diff in the Diff tab.
- **Details section**: one row per selected commit (short hash, title, author); click a row to expand
  the full message, author, committer, date and branches. A single selected commit is expanded at once.
- **Diff tab**: one editor tab per repository; the next file you open replaces its content. Side by
  side or unified, with changed words highlighted and syntax highlighting for 26 languages (light and
  dark palettes in the style of WebStorm, the plugin's own because Orca does not pass theme token colors
  to plugins). Toggle **Whole file** for full context, jump between changes with F7 / Shift+F7 and
  between the files of the selection it was opened from with ← / → (keys or header buttons) or Alt+↑ /
  Alt+↓ (counter "3/5 files"); the panel's Files section highlights the file the tab shows. Merge
  commits are compared with their first parent.
- **Looks like Orca**: whatever Orca passes to plugins comes from the current Orca theme, light or
  dark: backgrounds, text, borders, inputs and the focus ring, selection, menus, dialogs, buttons and
  corner radius (its 20 `--orca-*` tokens). What Orca does not pass follows WebStorm (Islands Dark and
  Islands Light): file status colors, added and removed lines and words in the diff, graph lanes and
  ref icons. The interface uses the system font; code uses JetBrainsMono Nerd Font or JetBrains Mono
  when installed.
- **Multi-select**: click, Ctrl/⌘-click, Shift-click, arrows, Page Up/Down, Home/End, Ctrl+A.
- **Right-click menu** with icons (or Shift+F10):
  - Copy Revision Number (Ctrl+C), Cherry-Pick, Create Patch… (`git format-patch` of the selection,
    oldest first, copied to the clipboard or saved to a file inside the repository only: a path
    outside it (such as `~/Downloads`), inside `.git` (under any name that reaches it) or through a
    link is refused; the file gets git's bytes as they are, and a patch with file content that is not
    UTF-8 can only be saved)
  - Checkout Revision, checkout a branch at that commit, check out a remote branch as local. Leaving a
    detached HEAD that holds commits on no branch asks first and offers a backup branch.
  - Reset Current Branch to Here… (soft / mixed / hard / keep), Revert Commits, Undo Commit
  - Edit Commit Message…, Fixup, Squash Commits…, Drop Commits, Interactively Rebase from Here…
  - New Branch…, New Tag…
- **Undo** banner after each rewrite (resets back to the previous HEAD with `--keep`). Rewrites and rebase
  onto move only the current branch, whatever `rebase.updateRefs` says, so Undo restores every branch
  they moved.
- **Backup before risky operations**: the confirmation offers to save a backup branch or tag first (see
  [Backups](#backups-before-risky-operations)).
- Commits already pushed to a remote branch trigger a warning before they are rewritten: by Edit Commit
  Message, Fixup, Squash, Drop, the interactive rebase, Undo Commit or Rebase Current onto This.
- An action runs in the repository its menu was opened on. If the workspace switches to another
  repository while a dialog is open (or, for an action on the current branch or a checkout, HEAD
  moves), nothing runs and a banner says so. The worker checks HEAD once more right before it runs
  such an action, and Undo runs only while HEAD is still where the action left it. Merge, rebase onto
  and deleting an unmerged branch run only while that branch is still at the commit the menu showed.
  New branch, rename and checkout refuse names git would expand, like `@{-1}`, names under `refs/`
  and names shaped like a full commit hash; checkout takes only a local branch (`git switch --no-guess`) or, for
  Checkout Revision, a full commit hash given as `<hash>^{commit}` so that a branch named like the
  hash cannot take its place, and merge and rebase onto take the branch's full ref. Warnings git
  prints while an action succeeds show in the banner under its message.
- While a rebase, merge, cherry-pick or revert started elsewhere (a terminal) is stopped, the worker
  refuses every action that moves HEAD or touches the work tree, and the menus disable them; a new
  branch without checkout and a new tag still work. A cherry-pick or revert that left only its todo
  list (`.git/sequencer`) is named as such, with `git cherry-pick --quit` (or `git revert --quit`) as
  the way out.
- In a shallow clone (`git clone --depth`), the commit the fetched history starts at cannot be
  rewritten, reverted, cherry-picked or undone: git would take it for the first commit, cut the
  branch off its history or delete files. The message says to fetch the rest with
  `git fetch --unshallow` first.
- Every git command the worker runs, where its input comes from and how it is checked is listed in
  [docs/git-safety.md](docs/git-safety.md).
- **Refresh** re-reads the log and branches; **Fetch** runs
  `git -c fetch.parallel=2 fetch --all --no-prune --no-prune-tags` (so `fetch.prune`,
  `remote.<name>.prune` and `fetch.pruneTags` in your config delete neither remote branches nor local
  tags such as backups) and reports the result in the banner. It never asks for a password: it works
  through the SSH agent and git's credential helpers.
- Live refresh when the repository changes (commits, checkouts, fetches, rebases from a terminal).

## Where it shows

- **Right sidebar panel** "Git", the plugin's only view: the Branches, Commits, Files and Details
  sections in one column; in a narrow column a commit takes two lines (message, then author and date).
- **Diff tab**: opens when you click a file in the panel. Orca has no API for a plugin tab without a
  file, so the tab is a custom editor on a small anchor file, `.orca-git-log.gitdiff`, that the plugin
  writes at the root of the workspace holding the repository and adds to `.git/info/exclude`, so it
  never shows up as untracked. It is opened only in a workspace whose repository is the panel's. The
  plugin creates the anchor once and never replaces or writes through anything else of that name (a
  file of yours, a link, a folder): then the tab does not open and the panel says why. An
  anchor `.orca-git-log.gitlog` left by an earlier version (with a full "Git" tab) stays hidden the
  same way and can be deleted.

## Install

```sh
orca plugin install https://github.com/predmaxim/orca-git
```

Installed from the Git URL the plugin gets the id `predmaxim.git-log`. Orca first lists the access it
asks for and prints the command to re-run with `--approve <fingerprint>`. If the original plugin is
installed too, turn it off so the two do not both show: `orca plugin disable emamalet.git-log` or
`orca plugin uninstall emamalet.git-log`.

Requires Orca 1.4.248 or later and git 2.31 or later on the `PATH` (or set **Git executable** in the
plugin settings): git 2.30 does not know `rev-parse --path-format`, and older git was not checked.
With older git the panel still shows the log and diffs, but refuses every action that changes the
repository, backups included, and says which version it found; if `git version` cannot be read,
nothing is refused. The plugin runs as a `trusted-worker`: it starts `git` with your user account.
It starts git by its full path: a bare name is looked up only in the
absolute folders of `PATH`, never in the repository or through an empty or `.` entry, and a relative
**Git executable** is refused, so a `git` or `git.exe` inside a cloned repository never runs.
Variables such as `GIT_DIR` that would point git at another repository are removed from its
environment, and its `PATH` keeps only absolute folders, so nothing git starts by name (`cp`, `ssh`,
`gpg`) comes from the repository.

### Develop

```sh
orca plugin dev load .          # loads as local.git-log; prints a fingerprint, re-run with --approve <fingerprint>
orca plugin test .              # worker and graph tests on temporary repositories
orca plugin validate .
orca plugin shot local.git-log --panel log
orca plugin shot local.git-log --editor <repo>/.orca-git-log.gitdiff   # the Diff tab, once a file was opened from the panel
```

## How history rewriting works

Squash, fixup, drop, reword and the interactive rebase dialog all run `git rebase -i --autostash`
with a generated todo list (`GIT_SEQUENCE_EDITOR`) and messages written to a file, so no editor ever
opens; a message keeps its lines that start with `#`. The selection must be a run of non-merge
commits on the current branch. If the rebase stops on a conflict it is aborted, and the branch is
left exactly as it was. The same happens when a commit becomes empty on the way (it only undoes a
commit you drop, say), which git would otherwise drop silently, folding the next squash or message
edit into the commit below the selection: the banner names that commit; drop or keep both instead.
git 2.45 and later are asked for that stop as `--empty=stop`, older git as `--empty=ask`, the name
it knew then (the worker reads `git version` first). Once git finishes, the worker checks that the
branch holds the planned commits right on top of the commit below the selection; if not, the banner
says so and offers Undo. The history is read with NUL between fields and must be one unbroken
first-parent chain, so text in a commit message cannot add a commit to a rewrite. Messages are read
and written as UTF-8 whatever `i18n.logOutputEncoding` and `i18n.commitEncoding` say. If the
uncommitted changes do not apply cleanly to the rewritten branch, git keeps them in the stash: the
banner says so and offers no Undo. Git gives the changes back without their staging (new files stay
added), and the banner says that too; merge and rebase onto work the same way.

## Backups before risky operations

Squash, fixup, drop, edit message, the interactive rebase, reset (any mode), rebase current onto a
branch, deleting an unmerged branch (`git branch -D`) and leaving a detached HEAD that holds commits
on no branch ask in their confirmation whether to back up first. The box is checked by default: pick
a branch (the default) or a tag and keep or edit the suggested name,
`backup/<branch>-<YYYYMMDD-HHMM>` (`backup/detached-<hash>-…` for a detached HEAD,
with `-2`, `-3`… when the name is taken). Fixup, drop and rebase onto, which ran without a dialog when
nothing was pushed, now show one to make the offer. One operation makes one backup, however many
commits it touches: it points at the old tip of the branch (for a deleted branch, at that branch) and
keeps them all.

- The worker makes the backup in the same request, before the operation, with
  `git branch --no-track <name> <commit>^{commit}` or `git tag <name> <commit>`. An existing branch or tag is
  never overwritten; if the backup fails, the operation does not run (if only saving the stash fails,
  the message names the backup already made).
- The worker checks the name when you press the button, and the dialog stays open with the reason: a
  name git refuses, one under `refs/` or longer than 200 bytes, a taken name, or one that clashes with
  an existing ref folder (`backup/main` and `backup/main/x` cannot both exist).
- A reset first checks the work tree. When tracked files have uncommitted changes, a hard reset can
  also save them to the stash (`git stash create`, then `git stash store`; the work tree is not
  touched). The hard reset is still confirmed, and both dialogs list what it would destroy that the
  stash does not keep. The check compares the target with the index and the work tree
  (`git diff <target>`), so it also covers tracked files deleted or replaced with a folder; a folder
  where a file marked `--assume-unchanged` is tracked, which git diff skips, is searched too. Listed:
  untracked files, ignored ones included, at a path the target has and the index or work tree lacks
  (or inside a folder there), files named like a folder the target needs, and the same inside a
  nested repository of their own, where git does not look: there the plugin checks each folder on
  disk without following links, and a file or link standing where the target needs a folder is
  listed by its own path. First and in bold come the repositories (folders holding `.git`) inside a
  folder the target replaces with a file, at any depth: a submodule the target turns into a file, a
  tracked folder with its own `.git`, or one deeper in a plain folder. The reset deletes them whole,
  with their files and any history kept in them; neither the backup nor the stash keeps them. The
  search reads at most 10,000 folder entries and never follows links; a folder it cannot finish is
  named in bold as not fully checked rather than passed. A folder where the target has a submodule
  is kept by the reset and not listed. With `submodule.recurse=true` in the git config the reset also
  resets submodules: such a folder is then listed like any other, and every submodule of the index or
  the target that is populated (holds `.git`) or holds files of yours is named in bold, since the
  reset resets, removes or checks it out over them. What is inside (uncommitted changes, untracked
  files, commits on no branch) is not checked one by one, and neither the backup nor the stash keeps
  it. Edits to files marked `--assume-unchanged`, which git status and the stash skip but a hard
  reset writes back, are found by hashing those files (`git hash-object`, nothing written) and listed
  in bold; a file git cannot hash is listed too. If the index is too large to read (over roughly
  550,000 files), the dialog says in bold that those files and submodules were not checked, and the
  reset is still offered. A file created after the dialog opened is not listed.
- The banner names the backup and offers Undo and **Show Backup**, which opens its folder in the branch
  tree.
- Backup branches sit in the `backup/` folder of the branch tree, backup tags among the tags. Their menu
  has **Restore <branch> to This Backup…** (`git reset --keep`, with its own confirmation and backup
  offer; git refuses if it would overwrite local changes) and **Delete Backup** (only for `backup/`
  names, and only while the ref still points where the tree showed it).
- Settings: **Offer a backup before risky operations** (on) and **Backup kind** (branch). The last kind
  picked in a dialog is remembered there.

## Limitations

- Local workspaces only: SSH, WSL and paired-host workspaces are not supported yet.
- The diff viewer is read-only, and very large diffs are cut after 20,000 lines.
- The Diff tab steps through at most 2,000 files: for a larger selection it gets the 2,000 around the
  file you clicked.
- The Diff tab's content lives in the plugin's worker: after Orca restarts, a restored Diff tab shows
  its placeholder until you open a file again.
- Conflicts during a rewrite, cherry-pick or revert are not resolved in the panel; the operation is
  aborted (or, when Git is left mid-operation by a terminal command, a banner says so).
- With git before 2.47 (seen on 2.34.8 to 2.45.4; fixed in 2.47.0), a `pre-rebase` hook that refuses
  a rewrite or rebase onto leaves your uncommitted changes only in git's autostash: they are gone from
  the files and `git rebase --abort` fails. The banner says so and keeps giving the way back until it
  is done: run `git rebase --quit`, which stores them in the stash list, then `git stash pop --index`
  (or `git stash pop` if git reports conflicts in the index; the changes then come back unstaged).
- When several workspaces share the same name and branch, the panel matches the focused one through
  its terminal titles; if that is not enough it asks you to pick, and remembers the choice.

## Third-party code

The diff is highlighted with [highlight.js](https://highlightjs.org) 11.12.0 (BSD-3-Clause), vendored as ES modules in `src/vendor/highlight/` (core and 26 language files, 128 KiB, license next to them). They are the npm package `@highlightjs/cdn-assets` byte for byte; the plugin has no build step.

## License

MIT

File and folder icons are the New UI (expui) file-type icons of [JetBrains intellij-community](https://github.com/JetBrains/intellij-community) (Apache-2.0, `platform/icons/src/expui/fileTypes` and `nodes/folder.svg`, commit 2775e0a), vendored byte for byte in `src/vendor/jetbrains-icons/` (84 SVG files, 137 KiB, `LICENSE` and `NOTICE` next to them). Frames can only import code, so `scripts/gen-fileicons.mjs` embeds them into `src/ui/fileicons-data.ts` (142 KiB), which the file tree and the Diff tab draw as data URIs, the light or the dark variant by the `light`/`dark` class on `<html>`.
