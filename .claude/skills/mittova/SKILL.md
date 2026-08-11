---
name: mittova
description: How to work on Mittova safely — the Cloudflare account split, D1 migration hazards, the multi-tenant boundary, the two sanitiser modes, and the verify-before-believing rules. Load before changing anything in this repo, and especially before writing a migration, touching tenant scoping, or deploying.
---

# Working on Mittova

Every rule here was learned by breaking something in production. Where a rule
looks fussy, the incident that caused it is named — because the reason is what
tells you whether a new situation is the same one.

## 1. Which Cloudflare account

If you keep more than one Cloudflare account, check which one you are acting as
before every write. Both of the obvious routes pick the wrong one here:

- `mcp__plugin_cloudflare_*` tools authenticate as whichever account the plugin
  was connected with, which is not necessarily this project's. They do not
  error on a mismatch; they return the other account's resources, so a question
  about a Worker in this project comes back describing an unrelated one.
- Bare `wrangler` uses its own OAuth session, which is also whatever you logged
  in as last.

Pin the account explicitly instead, with a **scoped API token** — not a global
API key, which cannot be narrowed and grants everything on the account:

```bash
export CLOUDFLARE_API_TOKEN=...   # scoped: Workers Scripts, D1, R2, KV, Email
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler whoami   # must print the account that owns this deployment, first
```

Where those values come from is the operator's business — a password manager,
`pass`, `age`, 1Password's CLI — so long as it is not a file in a repository.
Whatever the source, the invariant is the last line: `wrangler whoami` agrees
before anything writes.

Nothing in this repository should ever contain a credential, an account id or a
zone id. This is the upstream project, not an installation of it: an operator
clones it and supplies their own `wrangler.jsonc` and `.dev.vars`, both
gitignored, in their own checkout. Any deployment detail that reaches this tree
— a path, an id, an account — is a bug in the upstream, however convenient it
was for whoever added it.

Runtime secrets are a different thing and never belong on disk: `CF_API_TOKEN`
is set with `wrangler secret put`, and `.dev.vars` is local-only and gitignored.

## 2. Migrations — the expensive lessons

**Never let a migration contain `DROP TABLE`.** drizzle-kit implements
"add a column in the middle of a table" as `CREATE __new_x` + `DROP TABLE x`,
guarded by `PRAGMA foreign_keys=OFF`. **D1 does not honour that pragma**, so the
drop cascades and silently empties dependent tables. This emptied
`user_mailboxes` here, revoking every user's mailbox access with no error. CI
now refuses such a migration, but check before you push:

```bash
npm run db:generate -- --name your_change
grep -n "DROP TABLE" migrations/<new>.sql   # must be empty
```

Appending a column instead of inserting it mid-table avoids the recreation.

**A hand-written migration needs a hand-written snapshot.** drizzle-kit diffs
`schema.ts` against `migrations/meta/<latest>_snapshot.json`. A migration with
no snapshot is invisible to it, and the next `db:generate` reproduces the whole
thing as a fresh migration. `No schema changes, nothing to migrate` is the check
that the chain is intact.

**Generate the baseline from the running database, not from `schema.ts`.**
drizzle-kit models neither the FTS5 virtual table nor the three triggers that
keep it in step with `messages`, so a generated baseline ships without search
and says nothing about it. When filtering FTS5's shadow tables out of a dump,
scope the filter to `type = 'table'`: the sync triggers are named
`messages_fts_insert/_delete/_update` and share the prefix. Filtering by prefix
alone removes all three.

**A squash does not reach an existing deployment.** `wrangler d1 migrations
apply` tracks by tag, so a database that already ran `0000_baseline` skips the
new one. Fresh installs are fine. Existing ones need the difference applied by
hand.

**The query builder's `.offset()` without `.limit()`** emits `OFFSET` with no
`LIMIT`, which SQLite rejects. This made every template save return 500 for
about an hour. Prefer one statement with `sql\`\`` for delete-all-but-N.

## 3. The tenant boundary

An **organization** is the tenant. Domains, mailboxes, users, templates,
contacts, suppressions, keys, webhooks and audit rows all belong to exactly one.

Four rules, each of which has been broken here:

**Resolve the tenant before reading anything that belongs to one.** A template
slug is unique only *within* a tenant, so an unscoped lookup returns an
arbitrary row among the tenants sharing it. Establish the org from the caller or
from the globally-unique thing they named (a mailbox address), then scope every
read by it. Reading first and reconciling afterwards looks equivalent and is not.

**Never accept a tenant from the client.** `writeOrg(scope)` is the one place
six routes agree on where a new row lands. An action derived from an existing
row — duplicating a template — takes the tenant *from that row, on the server*.

**Filters carry an inversion guard.** `undefined` means "across all tenants" and
must be reachable only by a platform administrator. Anyone else with no org gets
`sql\`1 = 0\``, never an absent filter:

```ts
function orgFilter(scope: Scope, column: AnySQLiteColumn) {
  if (scope.orgId) return eq(column, scope.orgId);
  return scope.isPlatformAdmin ? undefined : sql`1 = 0`;
}
```

**Put the org in the `WHERE`, not in a check afterwards.** A row in another
tenant then does not match, and answers 404 rather than 403 — a 403 confirms it
exists.

Leaks found here, for pattern recognition: an API key that could send as any
mailbox; public read endpoints returning every tenant's messages; a
last-active-owner count that spanned tenants; an audit trail with no tenant;
and `deliverToWebhooks` selecting every enabled endpoint on the deployment, so
one client's webhook received another's mail.

## 4. Two sanitiser modes

`sanitiseEmailHtml(html)` is for **prose typed into the composer** — a narrow
allowlist, no tables, no images.

`sanitiseEmailHtml(html, { layout: true })` is for **templates**, which are
authored HTML email: tables, images and the inline CSS a layout needs. Script,
iframe, object, form and event handlers are refused in both. An image source
gets the same scheme check as a link, plus `cid:`.

Do not widen the default to make a template work. Composed mail has no business
emitting a table, and widening it widens it for every send.

**Beware literal control bytes in source.** `safeHref`'s character class was
written with real NUL and US bytes instead of `\x00`/`\x1f`, which made
`html.ts` read as *binary* to `grep`, `ripgrep` and `diff` — searches over it
returned nothing at all, silently. If a grep of a file you know contains a
string comes back empty, run `file` on it before concluding anything.

Templates skip `wrapForEmail()`, which supplies the typography composed prose
lacks and would fight a layout that has its own.

## 5. Tests

Two vitest projects:

- **unit** — pure functions, in node. Fast, needs nothing.
- **worker** — routes, queries and the tenant filter, inside workerd against a
  real D1 built from `migrations/`. This is the only place D1's actual
  behaviour applies.

Add anything touching a route, a query or a filter to `test/`, and drive it
**end to end from the HTTP request**: the filter is only correct if middleware,
scope resolution and the query agree, and testing `orgFilter` alone proves none
of that.

**Mutation-test a security test before believing it.** Break the protection and
confirm the test goes red:

```bash
# e.g. make orgFilter return undefined, then:
npx vitest run --project worker
```

Four separate leaks here were caught by hand rather than by tests, so a green
suite is not evidence until you have seen it fail.

**Assert the positive too.** A test that only asserts "the other tenant's data
is absent" passes when *nothing happened at all*. One here did exactly that:
there is no `send_email` binding in tests, the send failed before the fan-out,
and an empty result read as success. Assert that the intended thing *did* occur
first.

## 6. Deploying and believing the result

**A deploy takes a moment to reach every edge.** Testing immediately after
`wrangler deploy` repeatedly showed old behaviour here, including a 404 on a
route that existed. Poll until the new behaviour appears rather than concluding
from one request.

**Check live state before changing it.** Infrastructure is edited by hand
between sessions. Re-query rather than trusting what a previous session or a
document recorded.

**Verify with real requests.** Screenshots and typechecks do not prove a route
works. Every real bug in this project was found by making a request and reading
the response.

## 7. Cloudflare Email Service, established by testing

- `POST /zones/{zone}/email/sending/subdomains` works with Email Sending Write
  alone; Cloudflare writes the DNS records itself, so no DNS permission is
  needed. `Subdomain already exists` means success.
- `POST /zones/{zone}/email/routing/enable` returns **403 for every scoped
  token**, even one holding all routing permission groups. Enabling routing is a
  dashboard step.
- `GET /zones/{zone}/email/routing` returns an authentication error: no
  permission group grants it. Infer receiving state from public DNS instead —
  the apex MX points at `route{1,2,3}.mx.cloudflare.net` only once routing is on.
- `CF_API_TOKEN` needs Zone Read across **all zones on the account**, or adding
  a domain cannot resolve its zone id and the automation silently does nothing.

## 8. Before you finish

```bash
npm run check                    # typecheck both halves, all tests
grep -rn "DROP TABLE" migrations/  # must be empty
```

Follow `git-conventions` for commits. State what you verified and how; if
something is untested, say so rather than implying it works.
