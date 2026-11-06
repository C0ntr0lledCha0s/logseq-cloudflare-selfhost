---
name: compound
description: Capture what a piece of work taught into docs/solutions, and promote recurring lessons into REVIEW.md defect classes or CLAUDE.md gotchas. Use after any fix or feature done outside a lane, after a debugging session, or when the owner says "remember this for next time", "add that to the learnings" or "compound this".
argument-hint: "[what to capture, or blank for the current branch]"
---

# Compound

1. Gather the context: the argument, this conversation's findings, `git log origin/main..HEAD`, and `git diff origin/main...HEAD --stat`. If the lesson came from a Logseq issue, note the item number.
2. Run the `compounder` agent (Agent tool, `subagent_type: "compounder"`). Give it the context as a short brief: the symptom, the cause, the fix, what misled you, and any review findings with their verdicts. It follows its own steps (dedupe, write, promotion rule, false positives, prune), and returns retro proposals for the lanes, which you show the owner rather than apply.
3. Review what it changed with `git diff -- docs/solutions REVIEW.md CLAUDE.md`. Check that each promotion is one line with a link and is actually true.
4. Commit on the current branch as `docs(learnings): <lesson>` and push if the session's instructions say to.
5. Report in one or two lines: the entry written or updated, and any promotion. Pass on any Logseq skill suggestions as suggestions only.
