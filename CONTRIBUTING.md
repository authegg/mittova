# Contributing

Thanks for looking. This file covers the parts of the project that are not
obvious from reading the code, because every rule below exists in response to
something that broke.

## Getting it running

```bash
git clone https://github.com/authegg/mittova.git
cd mittova
npm install && npm --prefix dashboard install
cp wrangler.example.jsonc wrangler.jsonc   # then fill in your own ids
```

`npm run setup` will create the Cloudflare resources and write that file for you.
See the README's quick start for the whole path from an empty account to a
working mailbox.

```bash
npm run dev                      # worker on :8787
npm --prefix dashboard run dev   # SPA on :5173, proxying /api
```

The one command that has to pass before anything is ready:

```bash
npm run check   # formatting, typechecks the worker and the dashboard, every test
```

Formatting is Prettier's job, so it is never worth arguing about in review. If
`check` complains about it, run `npm run format` and commit the result. Prose,
the issue forms and the example wrangler config are left alone deliberately.

## Three things that will bite you

These are the project's real hazards. Nothing else here is unusual.

**1. A migration must never contain `DROP TABLE`.** SQLite cannot always
`ALTER TABLE`, so drizzle-kit implements "add a column in the middle of a table"
as `CREATE __new_x` + `INSERT SELECT` + `DROP TABLE x`, guarded by
`PRAGMA foreign_keys=OFF`. **D1 does not honour that pragma.** The drop cascades
and silently empties every table referencing the one being replaced, with no
error. It has already happened here once, emptying a join table and revoking
every user's mailbox access. Append columns rather than inserting them
mid-table, and check before you push:

```bash
npm run db:generate -- --name your_change
grep -n "DROP TABLE" migrations/<new>.sql   # must print nothing
```

CI refuses such a migration too, but find it before CI does. If you hand-write a
migration, hand-write its snapshot as well — `npm run db:generate` printing
`No schema changes, nothing to migrate` is how you know the chain is intact.

**2. The tenant boundary is enforced in the query, not after it.** An
organization is the tenant. Resolve it from the caller or from a globally unique
thing they named, then scope every read by it in the `WHERE`. Never accept a
tenant from the client. When a filter cannot be resolved, fail closed — a caller
with no organization who is not a platform administrator matches `1 = 0`, never
an absent filter, because an absent filter means "every tenant". Prefer 404 over
403 for a row in another tenant, since a 403 confirms it exists.

**3. There are two sanitiser modes, and they are not interchangeable.**
`sanitiseEmailHtml(html)` is for prose typed into the composer: a narrow
allowlist, no tables, no images. `sanitiseEmailHtml(html, { layout: true })` is
for templates, which are authored HTML email and need tables, images and inline
CSS. Do not widen the default to make a template work — that widens it for every
send.

`.claude/skills/mittova/SKILL.md` has the longer version of all three, including
the incidents behind them.

## Tests

Two vitest projects. **unit** runs pure functions in node. **worker** runs
routes, queries and the tenant filter inside workerd against a real D1 built
from `migrations/` — the only place D1's actual behaviour applies, and the only
place a claim about isolation means anything.

Anything touching a route, a query or a filter belongs in `test/`, driven end to
end from the HTTP request. Testing the filter helper alone proves nothing about
whether middleware, scope resolution and the query agree.

Two habits worth copying, both learned the hard way here:

- **Mutation-test a security test before believing it.** Break the protection,
  confirm the test goes red, put it back. Four separate isolation leaks in this
  project were caught by hand rather than by a green suite.
- **Assert the positive as well as the negative.** A test that only checks "the
  other tenant's data is absent" also passes when nothing happened at all. One
  here did exactly that: the send failed before the fan-out and an empty result
  read as success.

## Commits and pull requests

Conventional Commits, matching what is already in `git log`:
`type(scope): subject`, imperative and lowercase, no trailing period. Scopes in
use include `site`, `api`, `auth`, `db`, `email`, `events`, `ops`, `security`,
`templates`, `deploy`, `ci`. One logical change per commit; split by area rather
than shipping a single large one.

Say what you verified and how. If part of a change is untested, say that rather
than implying it works.

## Never commit

Deployment configuration and credentials stay out of the repository:
`wrangler.jsonc`, `.dev.vars`, `worker-configuration.d.ts` and anything holding
an account id, zone id, API token or password are all gitignored. The committed
`wrangler.example.jsonc` carries placeholders only. Check your diff before
staging.

Security issues go through
[a private advisory](https://github.com/authegg/mittova/security/advisories/new),
not a pull request or a public issue. See [SECURITY.md](SECURITY.md).
