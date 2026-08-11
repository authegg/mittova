---
name: git-conventions
description: Branch naming and conventional-commit rules for this repo. Use before any commit, branch creation, or PR, and when the user says "commit this" or "clean up the history".
---

# Git Conventions

## Commits: Conventional Commits

Format: `type(scope): subject`

- **Types**: `feat` (user-visible change), `fix` (bug fix), `chore` (tooling/config/deps), `docs` (docs and skills), `refactor` (no behavior change), `perf`, `style` (formatting only), `ci` (pipelines), `test` (tests only).
- **Scopes used in this repo**: `api` (`src/api/`), `auth` (`src/auth.ts`, sessions and the tenant boundary), `db` (`src/db/`, `migrations/`), `email` (`src/email/`, ingest, send, threading), `site` (the React dashboard in `dashboard/`), `deploy` (domain onboarding, routing, health checks), `ops` (`scripts/`), `skills` (`.claude/skills/`). Scope optional for broad changes (`chore: scaffold the worker project`).
- **Subject**: imperative, lowercase, no trailing period, under ~70 chars. Say what the change does, not what you did ("add contact endpoint", not "added" or "adding").
- Body only when the why isn't obvious from the diff. No em-dashes.
- Footer: when an AI model did the work, the last line credits **that** model, by the name it
  actually runs under — never a name copied from an older commit:
  `Co-Authored-By: <model name> <noreply@anthropic.com>`
  e.g. `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. A commit written
  entirely by hand takes no trailer.

Examples from history: `feat(auth): sessions, roles and the tenant boundary`, `feat(email): inbound ingest, outbound send and rfc 2822 threading`, `feat(api): dashboard api, a bearer api and signed webhooks`, `ci: checks, dependency automation and issue templates`.

## Branches

- Default branch: `main` (never `master`). CI runs `npm run check` on every push.
- Small direct commits to `main` are fine for this solo repo. For multi-commit or risky work, branch: `type/short-kebab-slug` — `feat/eml-export`, `fix/webhook-retry-backoff`, `chore/dep-bumps`. Merge back with a regular merge or squash; delete the branch after.
- Never force-push `main` once the GitHub remote exists.

## Grouping rule

One logical change per commit. When a work session touched several areas, stage by path and split:
worker (`src/`) / dashboard (`dashboard/`) / schema (`src/db/`, `migrations/`) / tests (`test/`) / config (dotfiles, `package.json`, `tsconfig.json`, `vitest.config.ts`) / skills (`.claude/skills/`). Don't ship a single "wip: everything" commit.

A generated migration ships in the same commit as the `schema.ts` change that produced it, along with its `migrations/meta/` snapshot — a migration without its snapshot breaks the next `db:generate`. See the `mittova` skill.

## Cautions

- `git status` before and after every commit; the tree must end clean or intentionally dirty.
- Nothing in this repository may contain a credential, an account id or a zone id. Deployment config lives in a separate checkout and is gitignored here; check the diff before staging.
- Commit or push only when the user asks. History rewrites (reset/rebase) only on explicit request and never after pushing. A commit made right after a rewrite has lost its trailer before — check the last line.
