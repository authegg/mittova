# Contributing

Thanks for looking. This file covers the parts of the project that are not
obvious from reading the code, because every rule below exists in response to
something that broke.

## Getting it running

```bash
git clone https://github.com/authegg/mittova.git
cd mittova
npm install && npm --prefix dashboard install && npm --prefix site install
cp wrangler.example.jsonc wrangler.jsonc   # then fill in your own ids
```

Three packages, three dependency trees: the Worker at the root, `dashboard/`
(the product UI, React) and `site/` (the marketing page at mittova.com, static).

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

## The public site and the demo

Two deployments belong to the project itself rather than to anyone running
Mittova, and they are deployed by deliberately different routes.

### mittova.com — automatic

`site/` is built and deployed by **Cloudflare Workers Builds**, connected to this
repository from the Cloudflare dashboard and building from the `site/`
subdirectory on every push to `main`. There is no deploy workflow here and no
Cloudflare token in GitHub secrets — this repository is public, and a token in a
public repository's secrets is one misconfigured workflow away from being used by
a fork. The connection is revocable from Cloudflare in one click, which is not
true of a credential that has been copied somewhere.

The consequence is that **whatever lands on `main` is deployed**. That is why no
Dependabot ecosystem here is auto-merged: auto-merge plus auto-deploy means an
unreviewed dependency bump ships to mittova.com on its own.

### demo.mittova.com — by hand, on purpose

The demo is **not** connected to Workers Builds, and should not be. Workers
Builds needs a committed `wrangler.jsonc`, and the demo's carries an account id
and D1, R2 and KV resource ids — exactly what may never enter this tree. A demo
changes rarely, so the manual step costs almost nothing.

From a checkout that has credentials:

```bash
cp wrangler.demo.example.jsonc wrangler.demo.jsonc   # then fill in the ids
npx wrangler d1 migrations apply mittova-demo --remote --config wrangler.demo.jsonc
npx wrangler secret put ADMIN_PASSWORD --config wrangler.demo.jsonc
npm run build
npx wrangler deploy --config wrangler.demo.jsonc
```

`wrangler.demo.jsonc` is gitignored, like `wrangler.jsonc`. Read the comments in
`wrangler.demo.example.jsonc` before changing anything: they record which parts
are load-bearing.

### What keeps the demo safe

Four independent things, and the point is that they are independent — any one of
them failing alone changes nothing:

1. `DEMO_MODE` is `"1"`, so `sendEmail` refuses before reaching the wire.
2. The demo's config omits the `send_email` binding, so there is no `env.EMAIL`
   to call even if the flag were wrong.
3. **Email Routing is never enabled on mittova.com.** The demo therefore cannot
   receive mail at all. A public inbox that anyone can write to is a
   content-moderation problem, and enabling routing is a deliberate dashboard
   step — so simply never take it.
4. No `CF_API_TOKEN` secret is set, so domain onboarding cannot reach the real
   Cloudflare API.

The hourly reset fails closed the other way: it runs only when `DEMO_MODE` is
exactly `"1"`, checked both by the `scheduled` dispatch and again inside
`resetDemoData`. Any other value means off, because a demo that stops resetting
merely goes stale while a real deployment that reset itself would lose
everything. `test/demo.test.ts` covers both directions; every guard there has
been mutation-tested, including the redundant one.

The demo's content is `src/services/demo-seed.sql`, which is also what
`npm run seed:demo` loads locally. One file, two readers, on purpose.

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
`wrangler.jsonc`, `wrangler.demo.jsonc`, `.dev.vars`,
`worker-configuration.d.ts` and anything holding an account id, zone id, API
token or password are all gitignored. The committed `wrangler.example.jsonc` and
`wrangler.demo.example.jsonc` carry placeholders only. Check your diff before
staging.

Security issues go through
[a private advisory](https://github.com/authegg/mittova/security/advisories/new),
not a pull request or a public issue. See [SECURITY.md](SECURITY.md).
