# Security Policy

## Supported versions

Security fixes are currently provided for the latest `0.1.x` release. The
project is pre-1.0; upgrade to the newest patch before reporting a regression.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use a
[private GitHub security advisory](https://github.com/miku233333/aiagent-memoryhub/security/advisories/new)
and include:

- affected version and operating system;
- reproducible steps or a minimal proof of concept;
- expected impact and required attacker access;
- any suggested mitigation, without including real credentials or user data.

Maintainers will acknowledge a complete report as soon as practical, coordinate
validation and remediation privately, and credit reporters who want attribution.
Please allow time for a fix before public disclosure.

## Security boundaries

AI Agent MemoryHub treats synchronized context as untrusted data, keeps writes
approval-oriented, and binds its local backend to loopback. Reports about
secret exposure, scope bypass, unsafe projection, arbitrary code execution,
update integrity, or installer trust are in scope.

Requests to bypass provider eligibility, geographic restrictions,
account-integrity checks, or abuse-prevention controls are not supported by this
project and are outside this disclosure process.
