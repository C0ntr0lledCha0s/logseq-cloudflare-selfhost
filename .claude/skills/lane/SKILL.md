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
3. If the argument is an item number (`N` or `LC-N`), find the item's task and read it. Read only.
   - Each item is one heading task whose title starts `LC-N:`, with its own `itemNumber`. Find it with one `datalog_query` for the block whose `itemNumber` property equals N, on the issues page or its archive (the page title plus ` Archive`, which holds Done and Canceled items), both matched by title. Match properties by their title (`itemNumber`, `component`, `dependsOn`, `foundIn`, `branch`, `pr-url`, plus the built-in Priority and Status), never by a hard-coded ident or UUID, and pull the task's uuid, title, tags, Priority, Status, component, dependsOn, foundIn, branch and pr-url with titles for the referenced values. If the query finds nothing, `search_graph` for `LC-N`.
   - Read the item with `get_blocks` (`view: "outline"`): the notes under the task (Problem, Repro, Proposal, Acceptance criteria and so on) end in a **Log** block of dated entries. Take labels from the task's tags and component, and dependencies from `dependsOn`, never from text.
   - Old references such as `64d` or `Connector #58` are mapped to new numbers in the **Renumbered** notes under the page's Summary.
   - If the task is already Done or Canceled, say so and stop unless the owner insists.
   - If it depends on an item that isn't done (a `dependsOn` task whose Status isn't Done), say so and ask before continuing.
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

Show `closeout.logseq_update` (or the spike's `logseq_update_hint`) and the result's `logseq_properties` (`{status, phase, branch, pr_url}`; a feature stopped at its spec or plan returns it too). If you opened a PR, put its URL in `pr_url` first. Ask once: "Write this to LC-N's Log and set its Status to <status>, phase, branch and pr-url?" Only on yes, follow the Logseq skill's writing rules:

- Find the item's task as in section 1 step 3, and its **Log** child block. Insert the draft entry as the Log's last child with one `insert_block_children` call. If the item has no Log block, add one as the task's last child, with the entry under it.
- Set the facts as properties, never as text, in one `batch_set_block_property` call on the task: Status from `status`, `phase`, `branch`, and `pr-url` from `pr_url` (`pr-url` holds several PRs, so a follow-up PR is added, not replaced). Leave out any that are null: a null means "leave it as it is".
- After merge and deploy, set Status Done and move the task to the archive page, after the archive's last item.
- For a feature still in spec, add only a "**Spec <date>**" entry to the Log with a link to the file.
- Proposed new items from the closeout are created only on the owner's yes, each as its own numbered item (see section 4).
- Read the task back once with `get_block`, and report in one line, naming any property that didn't take (missing, or a different value from the one sent).

Also pass on `compound.skill_suggestions` and `docs.skill_note`. They are changes for the owner's own Logseq skill, which lives outside this repo. Offer them as suggestions; don't apply them.
