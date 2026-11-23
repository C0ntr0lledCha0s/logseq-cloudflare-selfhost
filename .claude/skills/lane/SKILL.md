---
name: lane
description: Run staged work on this repo through a lane, either a bug fix, a feature or a spike, from an item on the owner's Logseq Connector Issues page or a described problem. Routes to the lane-bug, lane-feature, lane-spike or lane-review workflow, handles the approval gates, commits and pushes, and offers the Logseq write-back. Use when asked to "work on item 23", "work on LC-104", "fix connector #25", "investigate this bug", "build the suggest_links tool", "spike the CLI replica" or "review this branch".
argument-hint: "<item number (N or LC-N) | description> [bug|feature|spike|review]"
---

# Run a lane

The lanes are described in `docs/lanes/README.md`, and `CLAUDE.md` has the repo rules. Invoking this skill is the owner's opt-in to run the lane workflows.

## 1. Work out what to run

1. Get today's date in the owner's time zone with `TZ=Pacific/Auckland date +%F`.
2. Read the tracker settings from `.claude/lanes.local.json` (`{"graph": "<alias>", "page": "<issues page title>"}`). The file is untracked, so it keeps the graph's name out of the repo. If it's missing, call `list_graphs`: if exactly one graph is connected, use it with the page **Logseq Connector Issues**. Otherwise ask the owner, and offer to write the file. Never put the graph name or page UUIDs in a committed file, commit message or PR body.
3. If the argument is an item number (`N` or `LC-N`), find the item and read it. Read only.
   - Each item is one heading task whose title starts `LC-N:`. Find it with `search_graph` for `LC-N`, then read it with `get_blocks` (`view: "outline"`): its tags, its properties (Status, Priority, phase, component, dependsOn, foundIn, branch, pr-url) and the notes under it, which end in a **Log** block of dated entries.
   - Finished items are on the page's archive (the page title plus ` Archive`). If the task is Done or Canceled, say so and stop unless the owner insists.
   - If its `dependsOn` names an item that isn't Done, say so and ask before continuing.
   - Old references such as `64d` or `Connector #58` are mapped to new numbers in the **Renumbered** notes under the page's Summary.
4. Pick the lane from the item's type tag, unless the owner named one:
   - `bug` for **Bug**, or a described defect
   - `feature` for **Feature** or **Improvement**
   - `spike` for **Spike**, or a question to answer
   - **Chore** items (housekeeping, docs, lane process) and **Epic** items (a group that ships as one PR, with child items) usually need no lane: say so and ask how to proceed
   - `review` to review the current branch only
5. If the description is ambiguous between bug and feature, ask. Otherwise proceed.

## 2. Prepare

1. **Branch.** If the session names a designated branch, use it. Otherwise create `fix/<slug>`, `feat/<slug>` or `spike/<slug>` from `origin/main`.
2. **Checks.** If the item touches `connector` or `patch` and `connector/vendor/` is missing, warn that the connector checks will be skipped. Offer to build first: `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream`, run in the background because it takes several minutes and needs mise's toolchain. A bug lane without the connector suite can't prove its regression test fails, so prefer building.

## 3. Run the workflow

Call the Workflow tool with the saved workflow's name and `args`. Every lane takes these common args:

- `today`
- `tracker`: the `{graph, page}` you resolved in section 1
- `trailer`: the session's commit attribution lines, verbatim. Lane agents commit as they go, one commit per stage.

| Lane | name | Lane-specific args |
|---|---|---|
| bug | `lane-bug` | `issue` or `brief`. Optional: `stop_after: "investigate"` when the owner only wants a diagnosis, `tier`, and `max_fix_rounds` (default from the tier). |
| feature | `lane-feature` | `issue` or `brief`. The first run stops after the spec. Rerun with `spec: "<path>"` after approval. Optional: `stop_after: "plan"` and `tier`. |
| spike | `lane-spike` | `issue`, or `brief` and `questions` |
| review | `lane-review` | `base: "origin/main"`. To re-check an earlier result, add `open` (its findings) and `round`. |

**Tier (bug and feature lanes).** Intake suggests `quick`, `standard` or `full` (see docs/lanes/README.md, *Tiers*) and the run log names it. Pass `tier` when the owner chose one. Never pass `quick` for a change that deletes, converts or restructures stored data or the schema, or touches auth, tokens or secrets. Report the tier in the status, with any should-fix items it left for the backlog.

Tell the owner which lane is running and that you'll report back. Don't predict results while it runs. If the run is interrupted, resume it with `resumeFromRunId`.

## 4. Act on the result

Read `status` first.

- **`awaiting-approval`** (feature): summarise the spec in five lines with a link to the file, and list its open questions. Push the branch so the owner can read the spec. Ask for approval or changes. Once approved, rerun with `spec`.
- **`blocked`**: say which precondition or stage stopped it and why. Examples are a dirty tree, being on main, or an unreadable issue.
- **`blocked-security`**: a security finding is still open. Don't push for a PR. Quote the finding (id, claim, evidence) and stop.
- **`needs-human`**: say which stage stopped and why, and quote the refuted hypotheses, a red gate or the open findings. Don't paper over it.
- **`not-a-bug`**: explain what the investigation found, and what the compounder recorded.
- **`ready-with-open-findings`** with `followup`: the lane has already run one targeted round on the blockers and majors that were still open, so these survived it. Show them as proposed backlog items (the closeout's *Proposed backlog items* section has each with its probe or test path), and offer a follow-up run only if the owner wants them fixed in this branch: one `implementer` addresses `followup.open` by id (fail-first tests, same patch number), then `lane-review` runs with `base: followup.review_base`, `open: followup.open` and `round: followup.next_round`. Open the PR as a draft until they are closed or moved to the backlog.
- **`ready`** / **`ready-with-open-findings`**:
  1. Check the work yourself: `git status --porcelain` (it should be empty), `git log --oneline origin/main..HEAD`, and `scripts/check.sh` (add `--upstream` if patches changed). Never report a check as passing that you didn't see pass. Confirm that `closeout.head_sha` matches HEAD.
  2. Push to the branch, then confirm that `git ls-remote origin <branch>` gives HEAD. Stage agents only commit, so this is the one check that the lane's work is on the remote.
  3. Report the result: what changed, the regression tests with their fail-before evidence, the review rounds (closed, refuted, open), the docs updated, the learnings recorded and promoted, and the live verification steps.
  4. List any open findings under "for your call", and the lane's `backlog` (pre-existing defects that skeptics confirmed) as proposed backlog items. Add them to the issues page or README *Backlog* only on the owner's yes. Each one becomes its own item: the next free number (one more than the highest `itemNumber` on the page and its archive), a type tag, and `foundIn` set to this lane's PR. Never add one as a child of the current item or reuse its number.
  5. Show the **retro proposals** (`compound.retro_proposals`). These are changes to the lanes themselves, each with its evidence. Apply only the ones the owner approves, in a separate `chore(lanes): …` commit.
  6. Offer to open a PR with `closeout.pr_title` and `closeout.pr_body`. Don't open one unless the owner says yes.
  7. Stop any warm compiler the lane left running: `scripts/upstream-test.sh .upstream --stop`. Lane agents run upstream tests one namespace at a time through it while they iterate; the gate (`scripts/check.sh --upstream`) still runs the full suite.

## 5. Logseq write-back (always ask)

Show `closeout.logseq_update` (or the spike's `logseq_update_hint`) and the property changes below. Ask once: "Write this to LC-N's Log and set it to In Review?" Only on yes, follow the Logseq skill's writing rules:

- Find the item's task (`search_graph` for `LC-N`) and its **Log** child block. Insert the draft entry as the Log's last child with one `insert_block_children` call. If the item has no Log block, add one as the task's last child, with the entry under it.
- Set the facts as properties, never as text, with one `batch_set_block_property` on the task: Status In Review, phase `review`, `branch`, and `pr-url` (it holds several PRs, so a follow-up PR is added, not replaced). After merge and deploy: Status Done. Then move a Done item to the archive page, after the archive's last item.
- For a feature still in spec, add only a "**Spec <date>**" entry to the Log with a link to the file, and set phase `plan`.
- Proposed new items from the closeout are created only on the owner's yes, each as its own numbered item (see section 4).
- Read back once to confirm, and report in one line.

Also pass on `compound.skill_suggestions` and `docs.skill_note`. They are changes for the owner's own Logseq skill, which lives outside this repo. Offer them as suggestions; don't apply them.
