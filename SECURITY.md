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
- **Where the key is sent.** Requests go to the configured z.ai endpoint:
  `https://api.z.ai/api/anthropic` for the tools and
  `https://api.z.ai/api/paas/v4/models` for the model list. `ZAI_BASE_URL` replaces that
  destination — if you set it, your key is transmitted to whatever host it names, so only
  point it at endpoints you trust. There is no telemetry and no phone-home beyond the
  configured endpoint.
- **Your key, your account, your billing.** Nothing routes through the maintainer.

## Supply chain

This repository holds no npm token or any other publish credential, and nothing in a
checkout needs one to build or test. The published tarball is limited by `package.json`'s
`files` list to the compiled JavaScript, the README and the licence, and installing it runs
no repository code.

Release publishing is moving to CI with npm trusted publishing (OIDC), provenance
statements and a maintainer approval step; until that workflow is merged, releases carry
no provenance to audit — compare a tarball's contents against the `files` list instead.
Once provenance is being published, check that it points at this repository.

## Scope

In scope: anything that leaks a credential, executes unintended code on a user's machine,
or lets a published artifact diverge from this repository's source.

Out of scope: vulnerabilities in z.ai's API itself — report those to z.ai.
