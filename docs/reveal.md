# Showing a commit from another program

Another program — the Workflow plugin's «Показать коммит в Git» — can ask the Git panel to show a commit: the panel opens
the repository the commit is in and selects it in the Commits section. The files of the commit are listed as for any
selected commit; no Diff tab opens.

## Why a file

Orca has no call from one plugin to another, stops a plugin's worker after a few idle minutes and drops a panel that is
not on screen. So the request waits in a file, and the panel takes it when Orca starts it.

## The contract

1. The program writes the request to `reveal.json` in the folder:
   - `$XDG_RUNTIME_DIR/orca-git-log/`;
   - else `/run/user/<uid>/orca-git-log/` when `/run/user/<uid>` exists;
   - else `<temp dir>/orca-git-log-<uid>/`;
   - on Windows `%LOCALAPPDATA%\orca-git-log\`.

   On Linux and macOS the folder must belong to the user and be closed to others (`0700`), the file must belong to
   the user: a request anyone else could have written is not taken. Write it whole (to a temporary name, then rename).
2. The request is one JSON object: `{ "root": "<absolute path inside the repository>", "hash": "<4–40 hex of the
   commit>", "at": <milliseconds since the epoch> }`. `root` may be any worktree of the repository.
3. The program then shows the panel: `orca plugin open <plugin key> --panel log` (the key of an installed copy is
   `<publisher>.git-log`, of a development copy `local.git-log`).
4. The panel, when it starts, takes the request (the file is removed whatever it holds), opens the repository at `root`
   and starts with the HEAD filter and an empty search. This lets the request select a commit even if the worktree's
   saved filters would hide it. The panel looks on HEAD first and then among all branches. A commit that is in
   neither gets the usual «not in the log» note. A request older than 30 seconds, malformed, or naming a commit the repository does
   not have is dropped.

A panel already on screen is not started again by `orca plugin open`, so it takes the request only at its next start,
within the 30 seconds.
