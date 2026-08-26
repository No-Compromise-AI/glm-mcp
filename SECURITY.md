# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/No-Compromise-AI/glm-mcp/security/advisories/new)
rather than opening a public issue. A public issue discloses the problem to everyone
before there is a fix.

This is a small project maintained by one person. You should get an acknowledgement within
a few days; please don't read silence as dismissal — send a follow-up.

## How this package handles credentials

Worth stating plainly, since this server holds an API key:

- **No credential ships in the package.** The published tarball contains only compiled
  JavaScript, the README and the licence. There is no key, endpoint, or account of the
  maintainer's in it.
- **The key is read from the machine running the server**, in this order:
  `ZAI_API_KEY` → `~/.config/zai/api-key` → the key ZCode stores, and that last one only
  when `GLM_MCP_ALLOW_ZCODE_KEY=1` is explicitly set.
- **It is never transmitted anywhere except z.ai.** The only outbound destinations in the
  source are `https://api.z.ai/api/anthropic` and `https://api.z.ai/api/paas/v4/models`.
  There is no telemetry and no phone-home.
- **Your key, your account, your billing.** Nothing routes through the maintainer.

## Supply chain

Releases are published from CI using npm trusted publishing (OIDC). There is no long-lived
npm token. Every release carries [provenance](https://docs.npmjs.com/generating-provenance-statements),
which cryptographically ties the published tarball to this repository and the workflow that
built it, and each release must be approved by a maintainer with 2FA before it becomes
installable.

If you are auditing a release, check that its provenance points at this repository.

## Scope

In scope: anything that leaks a credential, executes unintended code on a user's machine,
or lets a published artifact diverge from this repository's source.

Out of scope: vulnerabilities in z.ai's API itself — report those to z.ai.
