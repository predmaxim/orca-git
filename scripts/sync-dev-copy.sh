#!/bin/sh
# The post-commit and post-merge hooks link here: after a commit or merge on main, Orca's development copy of the plugin
# (~/Projects/orca-git-log-dev, a checkout nobody edits) moves to main too. Orca reloads a development folder on any change in
# it, agents' worktrees under .claude/worktrees included (stablyai/orca#43533), so it is not loaded from this checkout.
dev="$HOME/Projects/orca-git-log-dev"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] && [ -e "$dev/.git" ] || exit 0
git -C "$dev" checkout -q --detach main
