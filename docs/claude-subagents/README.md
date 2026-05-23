# Claude Code subagents for this project

The `.claude/` directory is gitignored, so the actual subagent files live
in `~/.claude/agents/` (user-global) or `<repo>/.claude/agents/`
(project-local) on each machine. The reference content for them is
checked in here so it survives across machines and is reviewable.

To install on a new machine, copy the three `*.md` files in this
directory to your chosen location:

```sh
# user-global (available in every project)
mkdir -p ~/.claude/agents
cp docs/claude-subagents/{props-calibrator,verdict-forensics,refresh-guardian}.md ~/.claude/agents/

# or project-local (this repo only)
mkdir -p .claude/agents
cp docs/claude-subagents/{props-calibrator,verdict-forensics,refresh-guardian}.md .claude/agents/
```

Restart your Claude Code session after installing. The three subagent
types become available as `props-calibrator`, `verdict-forensics`, and
`refresh-guardian`.

## What each agent does

- **`props-calibrator`** — pulls Axiom verdict↔outcome joins over a window,
  computes hit-rate slices, proposes a unified diff against
  `api/lib/rule-weights.js`. Suggest-only: never edits weights itself.
- **`verdict-forensics`** — given a player (and optional prop), reconstructs
  the full reasoning path of the most recent verdict by walking
  `rules_fired[]` against the rule modules.
- **`refresh-guardian`** — wraps `refresh-{prizepicks,bbref-splits,team-defense}`
  with post-write schema validation; restores the prior snapshot via
  `git checkout --` on failure. Backed by the `*:guarded` npm scripts and
  the `scripts/validate-*-snapshot.mjs` helpers.

When a calibration or forensics agent finishes, it writes its report to
`tmp/calibration-*.md` or `tmp/forensics-*.md` in the working tree. The
agents are not permitted to edit engine/rule/weight files or commit
anything.
