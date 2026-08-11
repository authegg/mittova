# Security policy

Mittova handles mail, and it holds more than one client's mail in one database.
Isolation bugs are the failure that matters most here, so they are the ones this
policy is written around.

## Reporting a vulnerability

Report privately through GitHub, using
[**Report a vulnerability**](https://github.com/authegg/mittova/security/advisories/new)
on the Security tab. That opens a draft advisory only you and the maintainers can
read.

Please do not open a public issue for anything that looks exploitable, and please
do not test against a deployment you do not run yourself.

Useful in a report, roughly in order of usefulness:

- the request that demonstrates it, including which role and which organization the
  caller belonged to
- what you expected the response to be, and what it was
- whether it crosses an organization boundary, since that raises the severity here
  more than anything else

## Supported versions

`main` is the supported version. This is a self-hosted application with no release
channel behind it: a fix lands on `main` and you redeploy.

## What the threat model assumes

Worth knowing before you decide whether something is a bug:

- **An organization is the tenant boundary, and it is enforced in the query
  layer** against a single D1 database, not by separate databases. A caller
  reaching another organization's rows is a vulnerability. Clients who need
  physical separation are expected to run separate deployments, and that is a
  documented limitation rather than a defect.
- **A tenant is never accepted from the client.** Anything that lets a request
  choose the organization a row lands in, or is read from, is a vulnerability.
- **A filter that goes missing fails closed.** A caller with no organization who
  is not a platform administrator matches nothing, rather than matching
  everything.
- **Two HTML sanitiser modes exist on purpose.** Composed prose gets a narrow
  allowlist; templates additionally get the tables, images and inline CSS that
  authored HTML email needs. Script, iframe, object, form and event handlers are
  refused in both. Anything that gets past either mode is a vulnerability;
  something a template is allowed to do that composed prose is not is by design.
- **A platform administrator can act in any organization.** That role is the
  operator of the deployment. It is not an escalation path unless you can reach
  it without being granted it.
- **The nightly backup spans every tenant** and is restricted to the platform
  administrator, deliberately. The per-tenant export at `GET /api/export` is the
  one intended to be handed to a client, and it redacts password hashes, API key
  hashes and webhook secrets.
- **Secrets at rest.** API keys are stored only as SHA-256 hashes and shown once
  at creation. Webhook payloads are HMAC-signed. A path that reveals a key after
  creation, or lets a signature be forged, is a vulnerability.
- **Deployment configuration is not in this repository.** `wrangler.jsonc` and
  `.dev.vars` are gitignored, credentials belong outside any checkout entirely,
  and no account id, zone id or key belongs in a commit. If you find one in the
  history, report it privately rather than opening an issue.

## Out of scope

- Cloudflare's own platform. Report those to Cloudflare.
- The dashboard step for enabling Email Routing. Cloudflare returns 403 on the
  enable endpoint for every scoped API token, so it cannot be automated; this is
  documented, not a defect.
- Missing rate limits on an endpoint you are authenticated to and authorized for,
  unless it crosses a tenant boundary or exhausts another tenant's quota.
- Anything requiring a platform administrator's credentials to reach.
