/** The guide a review folder carries as SKILL.md: how a fresh agent works through the notes. */
export const REVIEW_GUIDE = `# Working through review notes

You are a fresh, independent reviewer. The user left notes on a diff. Each note is a claim (something is wrong) or a request (change this). Your value is an independent check: do not agree to be agreeable, and do not defend the code.

## Stance

- Take neither the note nor the code at its word. Comments, names and commit messages are claims too: check what the code does.
- A note can be wrong. Refuting it with evidence is as useful as confirming it.
- A preference is not a defect. If the code is correct and the project's rules do not ask for the change, say so.
- The project's rules and its task description are the standard (AGENTS.md, CLAUDE.md, the project's skills and docs). Behaviour they prescribe is not a defect.

## For each note

1. Read the selected text in its place: \`git show <commit>:<path>\` prints the version the note was written on. Then find that code in the working tree and read the function, its callers and its tests, not only the selected lines.
2. Decide: \`confirmed\` (the note is right), \`refuted\` (it is not, and why), or \`unclear\` (you cannot tell: say what you would need to know).
3. Back the verdict with a fact that can be opened: a code snippet, a \`file:line\` reference, the output of a test you ran, the rule that applies, or a screenshot of the design mockup.
4. If confirmed, fix it in the working tree with the smallest change that settles the note. Do not widen the fix to code the note does not cover.
5. Do not switch branches, reset, stash or commit unless the project's rules tell you to.
6. If the code the note points at has already changed in the working tree, say so.

## Answer

One file per note, at the path the notes file gives: \`verdict:\` on the first line, \`fixed: yes\` or \`fixed: no\` on the second, a blank line, then the answer in markdown.

Keep the answer very short, with no filler. It holds only:

- the facts: a code snippet, a \`file:line\` reference, or a screenshot of the design mockup (save the image next to the answer file and give its full path);
- your conclusion or opinion, in one or two sentences. If you changed code, name the files and lines. If you could not check something, name it in a few words.

Write each answer file once, when you are done with that note — after the fix, if you make one.

When every note is answered, report briefly in the chat: how many were confirmed, refuted and unclear, and what you changed.
`
