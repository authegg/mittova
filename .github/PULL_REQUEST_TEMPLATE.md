## What this changes

<!-- What it does and why. If it fixes an issue, link it. -->

## How it was verified

<!--
Please be specific, and say what you did not test rather than leaving it
implied. "npm run check passes" is a fine answer; "should work" is not.
-->

- [ ] `npm run check` passes (typechecks both halves, runs every test)

## If this touches any of these

Tick only what applies. Each has caused an incident in this repository, so
each gets its own question.

**A migration**

- [ ] `grep -n "DROP TABLE" migrations/<new>.sql` prints nothing — D1 does not
      honour `PRAGMA foreign_keys=OFF`, so a table recreation cascades and
      silently empties dependent tables
- [ ] `npm run db:generate` reports `No schema changes, nothing to migrate`, so
      the snapshot chain is intact

**A query, a route, or authorisation**

- [ ] The organization is in the `WHERE`, not checked after the read
- [ ] The tenant comes from the server, never from the client
- [ ] A caller who cannot be resolved to an organization matches nothing rather
      than everything
- [ ] Covered by a test in `test/`, driven end to end from the HTTP request

**A security fix or a test that protects a boundary**

- [ ] I broke the protection, watched the test fail, and put it back
- [ ] The test asserts the intended thing happened, not only that the forbidden
      thing is absent

**The HTML sanitiser**

- [ ] The composer allowlist was not widened to make a template work
