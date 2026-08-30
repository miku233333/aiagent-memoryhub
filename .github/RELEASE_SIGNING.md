# Desktop release signing

The tag workflow packages on native macOS and Windows runners. Packaging never
publishes directly from `electron-builder`; the workflow classifies and verifies
artifacts before creating a GitHub release. All third-party Actions are pinned to
reviewed full commit SHAs, checkout never persists credentials, and only the
final publish job receives `contents: write`.

## Repository contract

- Product: `AI Agent MemoryHub`
- Version: `0.1.0`
- Bundle identifier: `com.miku233333.memoryhub`
- Update provider: `miku233333/aiagent-memoryhub`
- Backend resource: `Backend/ai-agent-memoryhub-sidecar` on macOS and the same
  name with `.exe` on Windows
- macOS update targets: both DMG and ZIP
- Windows installer target: NSIS

## Required repository protections

Before enabling tag releases:

1. Protect `main` with required review and required CI checks.
2. Create a GitHub Environment named `release-signing`.
3. Restrict that environment to release tags, add required reviewers, and store
   signing secrets and identity variables there.

The workflow resolves the pushed tag to a commit and fails unless that immutable
commit is reachable from `origin/main`. The two native packaging jobs are both
gated by `release-signing`. GitHub environment/branch rules remain repository
settings and must be configured by an owner; source code cannot enable them.

## GitHub Environment secrets and variables

For a signed and notarized macOS build, configure all of:

- secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, and
  `APPLE_APP_SPECIFIC_PASSWORD`;
- variable: `APPLE_TEAM_ID`, the exact ten-character Team ID expected in the
  Developer ID signature.

For a signed Windows build, configure all of:

- secrets: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`;
- variable: `WIN_EXPECTED_PUBLISHER`, the exact X.509 subject returned by
  `Get-AuthenticodeSignature`;
- variable: `WIN_EXPECTED_CERT_THUMBPRINT`, the exact 40-hex certificate
  thumbprint.

Certificate values accepted by `electron-builder`, including protected base64
or private secret URLs, should be stored only as encrypted Actions secrets.
Never commit certificate material or passwords.

Partial or malformed credential sets fail closed. With no private signing
credentials, certificate discovery is disabled and the workflow creates
ad hoc-signed, unnotarized macOS test artifacts and unsigned Windows test
artifacts. It retains those as Actions artifacts and may create an
explicitly unverified draft/prerelease; it never promotes them as a stable
release.

Secrets exist only on the audited packaging step. The trusted packaging wrapper
captures and unsets them before locked dependency installation, web/Electron
compilation, and PyInstaller. It re-injects them only into the final
`electron-builder` process. Identity variables are passed separately to the
verification step; private certificate/notary secrets are not.

## Verification gate

A stable release requires both platform jobs to pass:

- macOS: hidden build evidence, DMG, and ZIP each contain exactly the expected app;
  each copy passes strict/deep signature verification, the configured Team ID,
  Gatekeeper assessment, and notarization staple validation;
- Windows: `Get-AuthenticodeSignature` reports `Valid` for the installer and
  every packaged executable (including the backend sidecar), and both the
  publisher subject and certificate thumbprint match the configured identity
  exactly.

The unpacked application is retained only in the ignored
`desktop/.release-verification` directory between the native package and
identity-verification steps. It is never staged or uploaded. Both platforms
require one exact delivery artifact set with no directories. The verifier
rejects duplicate or extra entries, validates the updater YAML filenames,
sizes, and SHA-512 values, and emits a source-commit-bound SHA-256 manifest.
The publish job revalidates both manifests after artifact download and emits
`SHA256SUMS.txt`. Claims such as
"signed" or "notarized" must be based on those checks, not merely on the
presence of secrets or a successful build. An already published stable release
is immutable; the workflow refuses to replace its assets.

## Local test package

No signing credential is required for local test packaging:

```bash
./script/package_desktop.sh mac
```

The script uses the committed backend PyInstaller spec and verifies the exact
local artifact/update-metadata contract. macOS test bundles are ad hoc signed so
their internal integrity can be checked and they can be launched locally, but
they deliberately do not claim a Developer ID identity or notarization.

The current desktop lock uses `electron-builder` 26.15.3. If the project moves
to version 27, review the new signing schema and move macOS signing options to
`mac.sign` before enabling release signing.
