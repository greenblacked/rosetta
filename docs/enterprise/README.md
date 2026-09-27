# Enterprise Rollout Kit

**Who is this for?** Platform, DevOps, and security teams rolling Rosetta out to many
engineers/repos, not a single developer install.

**When should I read this?** Before piloting Rosetta org-wide: building an org
instruction layer, standing up an internal/air-gapped mirror, pinning a version, or
writing managed-settings policy.

**Scope.** [PLUGINS.md](../../PLUGINS.md) and [INSTALLATION.md](../../INSTALLATION.md)
cover a single engineer's install. This kit covers the four pieces a fleet rollout adds
on top: an org instruction layer, a controlled/offline distribution channel, a pin +
rollback procedure, and per-IDE managed-settings policy. It does not repeat plugin
contents or per-IDE install steps — read those first.

> [!CAUTION]
> Rosetta still requires prior approval from your manager and company to use (see
> [INSTALLATION.md](../../INSTALLATION.md)). This kit does not change that.

---

## 1. Build an org instruction layer

Rosetta's plugin generator (`src/rosettify-plugins`) merges one or more **domains** of
instructions in layered order. The shipped `core` domain is Rosetta's own instruction
set; an org domain sits on top of it.

### 1.1 Layout

Create `instructions/<release>/<org>/` with the same shape as
`instructions/<release>/core/`:

```
instructions/r3/<org>/
├── rules/
├── workflows/
├── agents/
├── skills/
├── configure/
└── templates/
```

`<org>` must be a single path-safe name (letters, digits, `-`, `_`) and must not be
`core`. Only add the subfolders you actually use — the generator does not require all
six.

### 1.2 How layering resolves (verified against `src/rosettify-plugins/src/vfs/source-resolver.ts` and `file-apply-overrides.ts`)

- `--domain core,<org>` requires **both** `instructions/<release>/core/` and
  `instructions/<release>/<org>/` to exist; a missing domain directory fails the build
  with a clear error (`Instruction source not found: ...`), so a typo'd org name never
  silently produces a core-only build.
- Domains layer **left to right**, core first (lower priority) then `<org>`
  (higher priority).
- A file at a path that exists **only** in `<org>/` is added as-is.
- A file at a path that also exists in `core/` is **appended after** the core content
  by default (both layers' content is bundled into one output file) — it does not
  silently replace core content.
- To fully **replace** a core file instead of appending after it, name the org file
  with the `~overwrite~` directive token, e.g.
  `instructions/r3/<org>/rules/bootstrap-alwayson~overwrite~.md` replaces (not appends
  to) `core`'s `rules/bootstrap-alwayson.md`. Use this narrowly — prefer appending so
  core fixes/updates keep landing in your org build.
- Multiple org domains are supported (`--domain core,acme,acme-eu`); each layers over
  the previous, same rules.

### 1.3 Build it

```bash
cd src/rosettify-plugins
npm ci && npm run build
node dist/cli.js \
  --release r3 \
  --domain core,<org> \
  --output <output-dir>
```

Add `--profile lightweight` for the lightweight build variant, and
`--deterministic-hooks true` if your org build ships deterministic hook bundles (see
`node dist/cli.js --help` for the full, currently-verified flag list — re-run it after
each `rosettify-plugins` upgrade, since flags can change between releases).

This produces the same `plugins/core-<ide>[-standalone]/` trees the public build does,
one per supported IDE, under `<output-dir>`.

### 1.4 CI: `build-org-plugins.yml`

[`.github/workflows/build-org-plugins.yml`](../../.github/workflows/build-org-plugins.yml)
wraps step 1.3 as a `workflow_dispatch`-only GitHub Actions workflow (least-privilege
`contents: read` permissions throughout, no untrusted expression interpolated into a
shell `run:` step). Trigger it manually with inputs `org_domain` (required),
`release` (default `r3`), and optional `profile` / `deterministic_hooks`; it uploads the
built plugin trees as a workflow artifact (`org-plugins-<run id>`, 14-day retention) for
the platform team to publish per section 2. It does not publish anywhere itself —
review the artifact, then push it to your mirror by hand or from a separate,
higher-privilege workflow.

With `deterministic_hooks: true`, the workflow builds `src/hooks` (`npm ci` + `npm run
build:quiet`) before invoking the generator, so `.js` hook bundles exist to copy — then
runs a verification step that fails the build if any generated `hooks.json` still
references a bundle `.js` file that wasn't actually copied, instead of silently shipping
a plugin whose hooks can't run.

---

## 2. Internal marketplace mirror / air-gapped install

### 2.1 Why

The public install path
(`claude plugin marketplace add griddynamics/rosetta`, and the equivalents in
[INSTALLATION.md](../../INSTALLATION.md)) points every engineer at
`github.com/griddynamics/rosetta` directly. A regulated or air-gapped environment
instead needs a channel the org controls end to end.

### 2.2 Mirror repo

1. Run the org build (section 1) on the release you want to ship.
2. Push the output into an internal repo shaped like this one's marketplace root: a
   `.claude-plugin/marketplace.json` (see this repo's own file for the schema) pointing
   `source` at the plugin folder(s) you built, plus the `plugins/<target>/` folders
   themselves.
3. Point IDEs at the mirror instead of `griddynamics/rosetta`:
   - Claude Code: `claude plugin marketplace add <your-org>/rosetta-mirror` (or the
     mirror's URL/local path — `claude plugin marketplace add --help` documents `<source>`
     as "a URL, path, or GitHub repo"; it does **not** expose a documented flag for
     pinning a specific ref/tag on install today — verify against current Claude Code
     vendor docs before relying on a `#<ref>`-style pin syntax. Until/unless that's
     confirmed, pin at the **mirror** instead: see 3.2 below).
   - GitHub Copilot (VS Code/JetBrains): set `chat.plugins.marketplaces` to the mirror's
     URL (verified field name — see [`configure/github-copilot.md`](../../instructions/r3/core/configure/github-copilot.md)
     and [`PLUGINS.md`](../../PLUGINS.md)).
   - Cursor: import the mirror repo as the team marketplace source (Cursor
     Teams/Enterprise plan required — see
     [`configure/cursor.md`](../../instructions/r3/core/configure/cursor.md) and
     [Cursor's team marketplace docs](https://cursor.com/docs/plugins#team-marketplaces)).
   - Codex/Antigravity: no marketplace concept today — mirror the **standalone zips**
     instead (next section) and extract them via your org's repo bootstrap/dev-env
     tooling.

### 2.3 Air-gapped install (no network to either GitHub or the mirror at install time)

1. On a network-connected machine, download `instructions.zip`, every
   `core-<ide>[-standalone]-*.zip`, and `SHA256SUMS` from the GitHub release (or your
   mirror's release) — see [INSTALLATION.md — Offline Installation](../../INSTALLATION.md#offline-installation-no-mcp)
   for the same zips used by the single-engineer offline path.
2. Verify integrity before moving the files anywhere:
   ```bash
   sha256sum -c SHA256SUMS
   ```
   (This checksum step and its exact invocation are generated and printed by
   [`publish-instructions.yml`](../../.github/workflows/publish-instructions.yml)'s own
   job summary — verified against that workflow.) Where your policy also requires
   provenance attestation, additionally run:
   ```bash
   gh attestation verify <zip> --repo griddynamics/rosetta
   ```
   Note this attestation step (`actions/attest-build-provenance`) runs with
   `continue-on-error: true` in the publish workflow today, so its absence on a given
   asset is not itself proof of tampering — treat the checksum as the primary integrity
   check and the attestation as defense in depth.
3. Copy the verified zips into your internal artifact store (Artifactory, Nexus, an
   internal file share) alongside `SHA256SUMS`, so every downstream consumer verifies
   against the same file.
4. Distribute per repo using [INSTALLATION.md — Offline Installation](../../INSTALLATION.md#offline-installation-no-mcp):
   extract `instructions.zip` to `instructions/`, and copy the bootstrap rule content
   into each IDE's instruction file, from the internal mirror's copy of
   `local-files-mode.md` instead of the public GitHub URL.

### 2.4 Standalone plugin zips (Cursor/Copilot/Codex/Antigravity)

The same `core-<ide>-standalone-*.zip` assets [PLUGINS.md](../../PLUGINS.md) documents
for a single engineer work identically from an internal mirror or artifact store — only
the download source changes (your mirror instead of
`github.com/griddynamics/rosetta/releases`). Re-verify against `SHA256SUMS` (2.3) before
extracting.

---

## 3. Pin a version and roll back

### 3.1 What "version" means for each mode

| Mode | Pin unit | Verified source |
|---|---|---|
| Plugin marketplace | the marketplace's `plugins[].source` folder content at whatever ref the marketplace repo's default branch (or the ref your mirror serves) currently points to | `.claude-plugin/marketplace.json` in this repo |
| Plugin standalone zip | the exact `core-<ide>[-standalone]-<version>.zip` you extracted | [INSTALLATION.md — Upgrading](../../INSTALLATION.md#upgrading) |
| Offline `instructions.zip` | the exact zip you extracted into `instructions/` | [INSTALLATION.md — Offline Installation](../../INSTALLATION.md#offline-installation-no-mcp) |

Today, `.claude-plugin/marketplace.json`'s `source` fields point at plugin folders by
**path**, not a pinned commit/tag — a marketplace consumer always gets whatever is on
the tracked branch when it refreshes (`claude plugin marketplace update`). **This repo's
own release tags (`vX`, `vX.Y`, and today also the patch tag `vX.Y.Z`) are force-moved
on every publish to `main`** (verified in
[`publish-instructions.yml`](../../.github/workflows/publish-instructions.yml) — see
`git tag -f "$tag"` / `git push origin ... --force` for all three tag levels), so a
consumer pointed at a moving tag or branch has no durable pin from the public repo
alone. Do the pinning at the **mirror**, which you fully control:

### 3.2 Pin (recommended pattern)

1. Build/verify the release you want to ship (sections 1–2).
2. Push it to a **dedicated, non-moving ref** on your mirror — an immutable tag per
   version (e.g. `rosetta-3.1.13`), never a branch that later publishes overwrite.
3. Point the mirror's `.claude-plugin/marketplace.json` `source` at that immutable
   tag/commit (or, for a git-repo mirror, keep the mirror's tracked branch itself frozen
   at that commit until you deliberately advance it — the simplest option, since
   `marketplace add` tracks a branch, not an arbitrary ref, per 2.2).
4. Record the pinned version and its `SHA256SUMS` alongside your change-management
   record, so "what version is in prod" is always answerable without re-deriving it.

### 3.3 Roll back

1. Identify the last known-good immutable tag/commit from 3.2's record.
2. Reset the mirror's tracked branch (the one `marketplace add`/`extraKnownMarketplaces`
   points at) back to that commit — `git reset --hard <last-good-commit> && git push
   --force` on the **mirror only**, never on `griddynamics/rosetta` itself.
3. Have engineers refresh:
   - Claude Code: `claude plugin marketplace update <mirror-name>` then
     `claude plugin update rosetta@<mirror-name>` (restart required — see
     [INSTALLATION.md — Upgrading](../../INSTALLATION.md#upgrading)).
   - Standalone/offline installs: redownload the pinned zip for the rolled-back version
     and re-extract, replacing the extracted files (same as an upgrade, just to an older
     version) — see [INSTALLATION.md — Upgrading](../../INSTALLATION.md#upgrading).
4. Because rollback only moves the mirror's ref, `griddynamics/rosetta` itself is
   untouched — this is purely a consumption-side control.

### 3.4 Ring rollout (optional, not verified against a shipped tool)

A common pattern: point a small canary ring's mirror ref at the newest version first,
hold the general ring on N-1 for a soak period, then advance the general ring's ref.
Rosetta ships no ring/canary tooling itself — implement rings as two mirror refs (or two
mirror repos) and split `extraKnownMarketplaces`/marketplace-add targets by ring in your
own device-management/CI config.

---

## 4. Managed-settings templates per IDE

Templates are under [`templates/`](templates/). Each documents, in its own
`_comment` field, exactly which fields are verified against this repo's docs and which
are not — **read the comment before using the file**, not just the JSON.

| Template | Verified fields | Delivery mechanism |
|---|---|---|
| [`claude-code.settings.json`](templates/claude-code.settings.json) | `extraKnownMarketplaces`, `strictKnownMarketplaces`, `enabledPlugins` (all three: [PLUGINS.md](../../PLUGINS.md), [`configure/claude-code.md`](../../instructions/r3/core/configure/claude-code.md)) | Commit as `.claude/settings.json` in a repo (project scope, verified). An OS-level, MDM-deployed `managed-settings.json` with higher precedence than project/user settings is a documented Claude Code enterprise feature in general, but this repo's docs do not state its exact file path per OS — **verify against Anthropic's current vendor docs** before relying on that delivery path for non-overridable enforcement. |
| [`copilot.vscode-settings.json`](templates/copilot.vscode-settings.json) | `chat.plugins.marketplaces` ([`configure/github-copilot.md`](../../instructions/r3/core/configure/github-copilot.md), [PLUGINS.md](../../PLUGINS.md)) | A workspace `.vscode/settings.json` (verified: any VS Code setting works this way), a Settings Sync profile, or your device-management tool's VS Code policy channel — **verify the exact policy key and precedence against current VS Code / GitHub Copilot vendor docs**; this repo's docs do not cover Group-Policy-style enforcement. |
| Cursor | none as a settings-file template | Cursor's team marketplace import (Teams/Enterprise plan) is configured in the Cursor product itself, not a settings JSON file this repo can template — see [`configure/cursor.md`](../../instructions/r3/core/configure/cursor.md) and [Cursor's team marketplace docs](https://cursor.com/docs/plugins#team-marketplaces). Cursor's **hooks** enterprise paths ARE documented and verified in [`configure/cursor.md`](../../instructions/r3/core/configure/cursor.md): `/Library/Application Support/Cursor/`, `/etc/cursor/`, `C:\ProgramData\Cursor\` (org-wide `hooks.json`) — that is a hooks channel, not a general settings/marketplace-pin channel, and standalone Rosetta plugins installed in Claude Code are picked up automatically by Cursor per [PLUGINS.md](../../PLUGINS.md), which removes the need for a separate Cursor marketplace pin in that setup. |
| Codex / Antigravity | none | No marketplace or managed-settings concept documented in this repo for either IDE today (see [`configure/codex.md`](../../instructions/r3/core/configure/codex.md), [`configure/antigravity.md`](../../instructions/r3/core/configure/antigravity.md)). Distribute via the standalone zip + your org's own repo/dev-env bootstrap (section 2.4). |

---

## 5. Related docs

- [PLUGINS.md](../../PLUGINS.md) — single-engineer plugin install and contents
- [INSTALLATION.md](../../INSTALLATION.md) — full install reference (plugin, MCP, offline)
- [CONFIGURATION.md](../../CONFIGURATION.md) — per-repo workspace setup after install
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — how the generator, VFS, and org layer work internally
- [`.github/workflows/build-org-plugins.yml`](../../.github/workflows/build-org-plugins.yml) — CI wrapper for section 1
- [`.github/workflows/publish-instructions.yml`](../../.github/workflows/publish-instructions.yml) — source of the `SHA256SUMS`/attestation steps referenced in section 2.3
