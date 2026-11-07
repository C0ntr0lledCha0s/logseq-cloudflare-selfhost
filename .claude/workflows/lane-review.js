export const meta = {
  name: 'lane-review',
  description: 'Review the branch diff through tests, correctness, data-integrity and light (efficiency, security and contract) lenses; skeptics verify each serious finding and mark pre-existing ones for the backlog; open findings from earlier rounds are re-checked by id',
  whenToUse: 'Before a PR, or called each round by lane-bug / lane-feature. args: {base?: "origin/main", brief?: object|string, context?: string, open?: finding[] (from the previous round), round?: number, mutation_base?: sha (later rounds: mutate only rules changed since), mutation_cap?: 12, tier?: "quick"|"standard"|"full", models?: {role: "opus"|"sonnet"|"inherit"}}',
  phases: [
    { title: 'Scope', detail: 'what changed, which lenses apply' },
    { title: 'Review', detail: 'one reviewer per lens (tests first), plus a re-check of every open finding id' },
    { title: 'Verify', detail: 'skeptics try to refute each new security/blocker/major finding (3/2/1) and say whether this diff introduced it' },
  ],
}

// Rules (borrowed from agent-deck's milestone workflow, scaled down):
// - Every finding gets a stable id (r<round>-<lens>-<n>) and stays open until a later round
//   re-checks that id on HEAD and reports it fixed WITH evidence. An id left out, re-checked
//   'open', or 'fixed' without evidence carries forward, so a quiet round can't close it.
// - New security/blocker/major findings face skeptics (3 for security, 2 for blocker, 1 for major);
//   a finding dies only on a strict majority refutation (so one refutation kills a major), and a
//   tie keeps it.
// - Skeptics also say whether the defect predates this diff. A surviving non-security finding that
//   a majority of its skeptics mark pre_existing goes to `backlog`, not `open`: the lane proposes it
//   as a backlog item instead of fixing it.
// - Security is always covered (by the light lens); an open security finding blocks the lane
//   outright, and a security finding never moves to the backlog.
// - Only two agents run at once on a 4-CPU container, so the tests lens (the slowest, as it runs
//   mutations) is first in LENSES and starts alongside the re-check of open ids.

const A = args || {}
// Model per role. Opus where a wrong call costs a bad fix or a missed defect (root causes, code,
// skeptics, the correctness/integrity/tests lenses, the light lens that carries security, design,
// spec, plan). Sonnet where the work is reading, sweeping, arithmetic or writing up (intake,
// research sweeps, docs, compound, closeout, scope, per-stage checks that review rounds back up).
// The same table is in every lane script; keep them in step. args.models overrides any role, e.g.
// {"models": {"docs": "opus"}}; "inherit" uses the session's model. Nested lane-review calls get
// args.models passed through.
const MODELS = Object.assign({
  intake: 'sonnet', closeout: 'sonnet', docs: 'sonnet', compound: 'sonnet',
  investigate: 'opus', skeptic: 'opus', implement: 'opus',
  design: 'opus', judge_risk: 'opus', judge_cost: 'sonnet', judge_fit: 'sonnet',
  spec: 'opus', plan: 'opus', stage_check: 'sonnet',
  scope: 'sonnet', recheck: 'opus',
  lens_tests: 'opus', lens_correctness: 'opus', lens_integrity: 'opus', lens_light: 'opus',
  research: 'sonnet', writeup: 'opus', challenge: 'opus',
}, A.models || {})
const M = role => (MODELS[role] && MODELS[role] !== 'inherit' ? { model: MODELS[role] } : {})
const BASE = A.base || 'origin/main'
const ROUND = A.round || 1
// Mutation step scope: round 1 mutates every rule the diff adds; later rounds only rules added or
// changed since the previous round's HEAD (mutation_base), since earlier rules were mutated then.
// At most MUTATION_CAP mutations per round; the rest are listed, never silently dropped.
const MUTATION_BASE = A.mutation_base || null
const MUTATION_CAP = A.mutation_cap ?? 12
// tier quick: one combined lens and no skeptic on a major (it stays open for the lane's targeted
// round). Security keeps its three skeptics in every tier.
const QUICK = A.tier === 'quick'
const SKEPTICS = QUICK ? { security: 3, blocker: 1, major: 0 } : { security: 3, blocker: 2, major: 1 }
const CARRIED = (A.open || []).filter(f => f && f.id)
const BRIEF = typeof A.brief === 'string' ? A.brief : JSON.stringify(A.brief || {}, null, 2)
const CONTEXT = A.context || ''
const J = x => JSON.stringify(x, null, 2)
const SEVERITIES = ['security', 'blocker', 'major', 'minor', 'nit']
const RANK = { nit: 0, minor: 1, major: 2, blocker: 3, security: 4 }
const serious = f => RANK[f.severity] >= RANK.major

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    empty: { type: 'boolean' },
    head_sha: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    areas: { type: 'array', items: { type: 'string', enum: ['patch', 'connector', 'semantic', 'migrations', 'scripts', 'infra', 'workflows', 'docs', 'claude-config'] } },
    summary: { type: 'string' },
    touches_storage: { type: 'boolean', description: 'D1, KV, Vectorize, Workers AI, R2 or crons' },
    touches_tool_contract: { type: 'boolean', description: 'tool names, inputs, outputs, descriptions, connector_help, manifest' },
  },
  required: ['empty', 'head_sha', 'files', 'areas', 'summary', 'touches_storage', 'touches_tool_contract'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
          file: { type: 'string' },
          line: { type: 'integer' },
          failure_scenario: { type: 'string', description: 'concrete input/state -> what goes wrong -> why it matters' },
          evidence: { type: 'string', description: 'what you ran or read that shows it' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'failure_scenario', 'evidence', 'fix'],
      },
    },
    mutations: {
      type: 'object',
      description: 'tests lens only: the mutation step this round',
      properties: { run: { type: 'integer' }, survived: { type: 'integer' }, skipped: { type: 'array', items: { type: 'string' } } },
    },
  },
  required: ['findings'],
}
const RECHECK_SCHEMA = {
  type: 'object',
  properties: {
    rechecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'open'] },
          evidence: { type: 'string', description: 'for fixed: file:line on HEAD and the passing test; for open: what still fails' },
          severity: { type: 'string', enum: SEVERITIES, description: 'only if it should be raised' },
        },
        required: ['id', 'status', 'evidence'],
      },
    },
  },
  required: ['rechecks'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    pre_existing: { type: 'boolean', description: 'true if the defect is present on the base without this diff (the diff neither introduced nor widened it)' },
    checked: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'pre_existing', 'checked', 'reason'],
}

const common = `Review the changes on this branch against ${BASE}: \`git diff ${BASE}...HEAD\` plus anything uncommitted (\`git status\`, \`git diff\`). Read the full files around each hunk, not only the diff. Only changes after ${BASE} are in scope; earlier commits on the branch were reviewed by their own lanes. If that diff touches nothing under patches/, don't build or run the upstream ClojureScript suite; the connector and scripts suites cover it. If it does, run single namespaces with \`scripts/upstream-test.sh <checkout> <namespace-regex>\` (a warm compiler, seconds per run) rather than the full suite. Any copy of upstream you make goes under the session scratchpad at lane-scratch/<your label>/ (copy only deps/{db-sync,common,db,outliner,graph-parser} and resources, and symlink deps/db-sync/node_modules back to .upstream's); when you finish, run \`scripts/upstream-test.sh <copy> --stop\` and delete the copy.
Brief for this work:
${BRIEF}
${CONTEXT ? `Context from the lane:\n${CONTEXT}\n` : ''}Read the docs/solutions entries relevant to the files touched. Report only findings with a concrete failure scenario and evidence; an empty list is a fine answer.${CARRIED.length ? `\nThese findings from earlier rounds are being re-checked separately; don't report them again: ${CARRIED.map(f => `${f.id} (${f.title})`).join('; ')}` : ''}`

phase('Scope')
const scope = await agent(
  `${common}\n\nDon't review yet. Describe the change: HEAD's SHA (git rev-parse HEAD), the files, the areas, a three-sentence summary, and whether it touches storage or the tool contract. Set empty=true if there are no changes.`,
  { ...M('scope'), label: `scope:r${ROUND}`, schema: SCOPE_SCHEMA, effort: 'low' },
)
if (!scope || scope.empty) {
  log('No changes to review.')
  return { empty: true, round: ROUND, open: CARRIED, backlog: [], should_fix: [], nits: [], refuted: [], rechecks: [], security_open: CARRIED.some(f => f.severity === 'security') }
}

const MUTATION_TEXT = `Mutation step: ${MUTATION_BASE ? `mutate only the rules or branches added or changed in ${MUTATION_BASE}..HEAD (\`git diff ${MUTATION_BASE}..HEAD\`); rules from earlier rounds were mutated then` : `mutate the new rules or branches in the diff`} that docs, a description or a docstring promise. Make at most ${MUTATION_CAP} mutations this round, choosing first the rules with no test that clearly targets them, then the rules guarding data (writes, deletes, refusals). For each: a one-line mutation in a scratch copy that removes it, run only the change's own test namespace(s) against it in one warm watch (\`scripts/upstream-test.sh <copy> <namespace-regex>\` for patches; the connector or scripts suite for those), restore it. Report every rule that survives (the tests stay green) as a finding, citing the promise. Fill mutations with the count run, the count that survived, and every rule you chose not to mutate (skipped), so nothing is dropped silently.`
const FULL_LENSES = [
  { key: 'tests', agentType: 'adversarial-reviewer', prompt: "Lens: tests. Use REVIEW.md \"Gates and tests\". For each behaviour the change claims, is there a test that was seen to fail without it? Revert the fix in a scratch copy and run the test to check. Does each test run the real handler, outliner or SQL? " + MUTATION_TEXT + " Do the PR or commit claims cover only checks run on HEAD?" },
  { key: 'correctness', agentType: 'adversarial-reviewer', prompt: 'Lens: correctness. Use REVIEW.md "Gates and tests" (fix the class) and "API and patches". Break it with realistic identifiers, empty and huge inputs, partial failure and retries.' },
  { key: 'integrity', agentType: 'adversarial-reviewer', prompt: "Lens: data integrity on the owner's live graph. Use REVIEW.md \"API and patches\" and \"Sync\": silent success, read-back through every read tool, order keys, one transaction per batch, destructive guards, and migrations that can't be re-run." },
  {
    key: 'light',
    agentType: 'adversarial-reviewer',
    prompt: `Lens: light, which covers ${scope.touches_tool_contract ? 'three' : 'two'} checks in one pass. Start each finding's title with the check that found it: [cost], [security] or [contract].
1. Cost and efficiency. Use REVIEW.md "Cost" and the budget table in .claude/agents/efficiency-reviewer.md. For each query, call or loop the diff adds to a request path or cron, write down rows read or written (or operations, or neurons) per call, calls per day and the product, against the Free plan's daily caps. Check response sizes, and look for duplicated or dead code. A projected cap overrun is a blocker; more than 10% of a daily cap from one feature, or a second copy of a rule that must stay in step, is a major.
2. Security. Use REVIEW.md "Security": owner-only access, graph token scope, secrets in logs, output, fixtures and commits, outbound fetches outside net/safe-fetch.ts, GitHub Actions pinning and permissions, and graph content treated as instructions. Use severity "security" only for an exploit you can show.${scope.touches_tool_contract ? `
3. The contract with Claude. Use REVIEW.md "Contract and docs". Do descriptions, connector_help, tools-manifest.json, README §11.8 and errors match the code on HEAD? Would an existing claude.ai caller break silently?` : ''}`,
  },
]
const LENSES = QUICK
  ? [{
      key: 'quick',
      agentType: 'adversarial-reviewer',
      prompt: `Lens: quick, one pass that covers tests, correctness, data integrity, security${scope.touches_tool_contract ? ' and the contract with Claude' : ''}. Start each finding's title with the check that found it: [tests], [correctness], [integrity], [security]${scope.touches_tool_contract ? ' or [contract]' : ''}. Use the matching REVIEW.md sections. Was each new test seen to fail without the fix, and does it run the real handler, outliner or SQL? Break the change with realistic inputs and partial failure. Check silent success and read-back. Use severity "security" only for an exploit you can show. ` + MUTATION_TEXT,
    }]
  : FULL_LENSES
log(`Round ${ROUND}: reviewing ${scope.files.length} files at ${scope.head_sha} through ${LENSES.map(l => l.key).join(', ')}${CARRIED.length ? `; re-checking ${CARRIED.length} open finding(s)` : ''}`)

const verifyPrompt = f => `Try to refute this review finding on HEAD (diff against ${BASE}). Default to refuted=true if you can't construct the failure.
Title: ${f.title}
Severity claimed: ${f.severity}
Where: ${f.file}${f.line ? ':' + f.line : ''}
Failure scenario: ${f.failure_scenario}
Evidence given: ${f.evidence || '(none)'}
Check the cited code, look for a guard, caller or test that prevents it, and run the relevant test if that helps (for a patch, \`scripts/upstream-test.sh <checkout> <namespace-regex>\`, not the full suite).
Then, whether or not you refute it, set pre_existing: is the defect there on ${BASE} without this diff? Run or read the same input against the base. A defect the diff introduced, or widened to new inputs, is not pre-existing. Before you confirm a design-gap finding (the change doesn't do X), check what upstream itself does for the same input, such as what the app's editor or value picker allows: if upstream behaves the same way, the gap is pre-existing.`

const recheckThunk = async () => {
  if (!CARRIED.length) return { rechecks: [] }
  return agent(
    `Re-check these open review findings on HEAD (${scope.head_sha}). For each id, return status "fixed" only with evidence: the code that fixes it (file:line on HEAD) and the test that proves it, with its passing output. Otherwise return "open" and say what still fails. Raise the severity if it turns out worse. Fixers' notes are claims to check, not facts.\nOpen findings:\n${J(CARRIED)}`,
    { ...M('recheck'), label: `recheck:r${ROUND}`, phase: 'Review', agentType: 'adversarial-reviewer', schema: RECHECK_SCHEMA },
  )
}

const reviewThunk = () =>
  pipeline(
    LENSES,
    lens => agent(`${common}\n\n${lens.prompt}`, { ...M('lens_' + lens.key), label: `review:${lens.key}:r${ROUND}`, phase: 'Review', agentType: lens.agentType, schema: FINDINGS_SCHEMA }),
    (res, lens) => {
      if ((lens.key === 'tests' || lens.key === 'quick') && res && res.mutations) {
        const m = res.mutations
        log(`Round ${ROUND} mutations${MUTATION_BASE ? ` (since ${String(MUTATION_BASE).slice(0, 7)})` : ''}: ${m.run ?? '?'} run, ${m.survived ?? '?'} survived, ${(m.skipped || []).length} not mutated${(m.skipped || []).length ? `: ${m.skipped.join('; ')}` : ''}`)
      }
      return (parallel(
        ((res && res.findings) || []).map((f, i) => async () => {
          const tagged = { ...f, id: `r${ROUND}-${lens.key}-${i + 1}`, lens: lens.key, severity: SEVERITIES.includes(f.severity) ? f.severity : 'blocker' }
          if (!serious(tagged)) return tagged
          const skeptics = SKEPTICS[tagged.severity]
          if (!skeptics) return { ...tagged, survives: true, verification: 'quick tier: no skeptic for a major; kept open' }
          const votes = (
            await parallel(
              Array.from({ length: skeptics }, (_, k) => () =>
                agent(verifyPrompt(tagged), { ...M('skeptic'), label: `verify:${tagged.id}:${k + 1}`, phase: 'Verify', agentType: 'adversarial-reviewer', schema: VERDICT_SCHEMA }),
              ),
            )
          ).filter(Boolean)
          if (!votes.length) return { ...tagged, survives: true, verification: 'skeptics returned nothing; kept as unverified' }
          const refutedBy = votes.filter(v => v.refuted).length
          const preExisting = votes.filter(v => v.pre_existing).length
          return {
            ...tagged,
            survives: refutedBy * 2 <= votes.length,
            pre_existing: preExisting * 2 > votes.length,
            verification: `${refutedBy}/${votes.length} skeptics refuted; ${preExisting}/${votes.length} say it predates this diff`,
            votes,
          }
        }),
      ))
    },
  )

// The re-check is started first, so it and the tests lens take the first two agent slots.
const [recheck, reviewed] = await parallel([recheckThunk, reviewThunk])

// Carried findings: open unless re-checked 'fixed' with evidence. Severity only ever rises.
const byId = new Map((((recheck && recheck.rechecks) || []).filter(r => r && r.id)).map(r => [r.id, r]))
const stillOpen = []
const closed = []
for (const f of CARRIED) {
  const r = byId.get(f.id)
  const fixed = r && r.status === 'fixed' && (r.evidence || '').trim().length > 20
  const severity = r && r.severity && RANK[r.severity] > RANK[f.severity] ? r.severity : f.severity
  if (fixed) closed.push({ ...f, recheck: r.evidence })
  else stillOpen.push({ ...f, severity, recheck: r ? `${r.status}: ${r.evidence || '(no evidence)'}` : 'not re-checked; carried as open' })
}
if (!recheck && CARRIED.length) log('The re-check agent returned nothing; every carried finding stays open.')

const fresh = ((reviewed || []).filter(Boolean).flat().filter(Boolean))
const seen = new Set()
const deduped = fresh.filter(f => {
  const k = `${(f.file || '').trim()}::${(f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
const survived = deduped.filter(f => serious(f) && f.survives)
// A pre-existing defect is proposed for the backlog rather than fixed in this lane, except a
// security finding, which always stays open and blocks.
const backlog = survived.filter(f => f.pre_existing && f.severity !== 'security')
const confirmed = survived.filter(f => !backlog.includes(f))
const refuted = deduped.filter(f => serious(f) && !f.survives)
const open = [...stillOpen, ...confirmed]
const lost = LENSES.length - ((reviewed || []).filter(Boolean).length)
if (lost > 0) log(`${lost} reviewer(s) returned nothing; their lenses aren't covered this round.`)
log(`Round ${ROUND}: ${closed.length} closed, ${stillOpen.length} still open, ${confirmed.length} new confirmed, ${backlog.length} pre-existing (backlog), ${refuted.length} refuted by skeptics.`)

return {
  empty: false,
  round: ROUND,
  head_sha: scope.head_sha,
  scope,
  lenses: LENSES.map(l => l.key),
  uncovered_lenses: lost,
  open,
  closed,
  backlog,
  should_fix: deduped.filter(f => f.severity === 'minor'),
  nits: deduped.filter(f => f.severity === 'nit'),
  refuted,
  security_open: open.some(f => f.severity === 'security'),
}
