#!/bin/sh
# The post-commit and post-merge hooks link here: after a commit or merge on main, Orca's development copy of the plugin
# (<main checkout>-dev, a detached checkout nobody edits, e.g. ~/Projects/orca-git-log-dev) moves to main too. Orca reloads a
# development folder on any change in it, agents' worktrees under .claude/worktrees included (stablyai/orca#43533), so it is
# not loaded from the checkout people work in. Any plugin repository can take this file as it is.
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
dev="$main-dev"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] && [ -e "$dev/.git" ] || exit 0
# Git hands its hooks the committing checkout's variables (GIT_INDEX_FILE=.git/index after a commit), which in the copy
# would name its .git file; githooks(5) says to clear them before Git works in another working tree.
unset $(git rev-parse --local-env-vars)
git -C "$dev" checkout -q --detach main
