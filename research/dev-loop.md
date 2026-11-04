# DSH dev loop for a local plugin — verified procedure (desktop app 0.2.1-rc.3)

Scope: how to author a hand-written DSH plugin, install it into the **live desktop profile**, iterate on it, and roll it back. Everything labelled **VERIFIED** was checked on this machine on 2026-10-28; **INFERRED** means read from shipped source/docs but not executed (reason given). The live profile `/Users/lanlan/.dsh/profiles/desktop` and `~/.dsh/cordis.patch.yml` were **not modified**; all experiments ran against copies under `/tmp`.

## 0. Version reality check (the single most important fact)

Two different DSH installations exist, and only one of them owns the `desktop` profile:

| | Global npm CLI | Desktop app that is actually running |
|---|---|---|
| Version | `0.1.5-rc.1` (`dsh -V`, VERIFIED) | `0.2.1-rc.3` (`CFBundleShortVersionString`, VERIFIED) |
| Code | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/*.js` | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/*` (306 packages) |
| `dsh plugin --profile desktop …` | **Rejected**: `error: profile "desktop" is managed exclusively by the Electron application` (VERIFIED, exact message) | Allowed internally (hidden `manageDesktopProfile` flag, `dsh/lib/bin.js:35-36,112-123`), and the app never uses the CLI for this — see below |
| Profile | can boot `web`, `headless`, … | owns `/Users/lanlan/.dsh/profiles/desktop` |

Running process (VERIFIED via `ps`):
`DeepSeek Harness --expose-internals …/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js …/app.asar/dsh /Users/lanlan/.dsh/profiles/desktop …/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs …/runtime/bin`

`dsh-desktop-host` imports `runProfile` from the app's own `@deepseek-ai/dsh/profile-boot` and boots the profile directory directly (`loadProfileDirectory`), so **the global 0.1.5 CLI is not just blocked from the desktop profile — it is the wrong runtime (0.1.5 vs 0.2.1-rc.3)**. Never use it for installing plugins into desktop.

## 1. Q1 — Can a hand-written local plugin be installed through the GUI? **Yes.**

The desktop app ships an install-capable plugin manager. The "Plugins" sidebar page is `@deepseek-ai/dsh-client-ui-plugin-manager`, and it is composed in the desktop profile (VERIFIED: composed dump contains `- id: ui-plugin-manager / name: '@deepseek-ai/dsh-client-ui-plugin-manager'`; the full desktop composition dump is 1280 lines, see §7 evidence).

GUI flow (from `dsh-client-ui-plugin-manager/README.md` + `dsh-plugin-manager/lib/index.js`):

1. Sidebar → **Plugins** → **Add plugin** (or its arrow → **Choose how to add a plugin**).
2. **Install a third-party plugin** opens the install dialog. The package field accepts:
   - a registry package name (+ optional version/tag/range),
   - a Git address,
   - a tarball URL,
   - **an absolute local path** ("absolute local path" is in the README's Add-plugin paragraph; `installBundle(spec)` is documented as "One package spec, including local paths relative to the invocation directory", `dsh-plugin-manager/lib/index.js:1971`).
3. **Install** first calls the Host's `pluginManager.inspect(spec, options)`, which for an absolute path just reads its `package.json`; it rejects a path that is not a package or declares no `dsh.bundle` (`problem: 'not-a-bundle'`).
4. The install then runs `pluginManager.installBundle(spec, options)`:
   - `pnpm add <spec>` in the profile directory (`/Users/lanlan/.dsh/profiles/desktop`) using the **app's bundled pnpm** (runtime manifest: pnpm `11.28.5`; historical `.plugin-manager/logs/*/pnpm.log` shows the manager's pnpm runs, e.g. `+ dsh-better-sidebar ^0.24.1` and a `- dsh-plugin ^1.4.3` removal — VERIFIED, those two ops are exactly how the currently-installed sidebar got there);
   - validates the installed package declares `dsh.bundle.patch`, parses the patch YAML and runs the DSH-version compatibility preflight (§6);
   - appends the package to `dsh.profile.bundles` in the profile `package.json` (install enables the bundle by default);
   - recomposes through HMR and reports an `application` outcome (`applied` / `restart-required` / `failed` / `overridden`).
5. Failed/cancelled installs restore `package.json` and `pnpm-lock.yaml`; local-directory installs are **links to the checkout** ("Local directory installation links the checkout instead", `references/host-plugin.md:35`), so later source edits affect the profile without reinstalling.

RPC / service names (for scripts or debugging; VERIFIED from `dsh-plugin-manager/lib/typert.host.js`):
`pluginManager/listBundles`, `pluginManager/listPlugins`, `pluginManager/inspect`, `pluginManager/installBundle`, `pluginManager/removeBundle`, `pluginManager/setBundle`, `pluginManager/setPluginEnabled`, `pluginManager/cancelInstall`, `pluginManager/waitForInstall`, plus events `plugin-manager/install-log`, `plugin-manager/install-state`, `plugin-manager/changed`.

There is **no marketplace-only restriction**. A separate optional marketplace exists (`dsh-plugin-market`, `dsh-client-ui-plugin-market`, `dsh-experimental-plugin-market-bundle`) but the Add-plugin dialog is the generic channel.

Agent-side alternative: the `plugin_manager` tool (`action: install_bundle`, `target: <absolute package dir>`), documented in the app's own authoring skill `dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:8`. In the desktop composition that tool row is **disabled** (`- id: tool-plugin-manager / disabled: true`, VERIFIED in the dump), i.e. it is only exposed in agent "Creator mode". It can be enabled with a profile patch row `- id: tool-plugin-manager` + `disabled: false` (`dsh-plugin-manager/README.md`, "For a deployment without agent presets…"). Interactive GUI is the path that works today with no config change.

## 2. Q2 — Exact file-level effects on the profile

`/Users/lanlan/.dsh/profiles/desktop/` (VERIFIED contents):

| File | Role | Touched by install? |
|---|---|---|
| `package.json` | `dependencies` (installed plugin packages) + `dsh.profile.bundles` (ordered patch-layer list, install appends) | **yes** |
| `pnpm-lock.yaml` | pinned graph; restored on failed install | yes |
| `pnpm-workspace.yaml` | `packages: ["."]`, `nodeLinker: hoisted`, `autoInstallPeers: false`; only `allowBuilds` is appended when a dependency's build scripts are approved | only on build approval |
| `cordis.patch.yml` | user patch layer (id-targeted overrides, `insert` lists, `!!js`) | **no** for install; **yes** when you toggle an individual row in the GUI |
| `node_modules/` | hoisted; local-path installs appear as links to the checkout | yes |
| `compatibility.json` | optional exact `package@version` → DSH-version exemptions | only when granting an exemption |
| `.plugin-manager/logs/<op>/pnpm.log` | captured pnpm stdout/stderr per operation | yes (app-written) |
| `cordis.yml` | empty root `[]`; launcher rewrites it each boot — never edit | boot only |

Minimal bundle shape (from the app's official template `templates/decoration`, VERIFIED):

```
my-plugin/
├─ package.json       # name, version, private, type: module, exports, files, dsh.bundle.patch, dsh.client
├─ cordis.patch.yml   # - insert: [{ id: my-plugin, name: '@local/my-plugin' }]
├─ index.js           # export function apply(ctx, config) {} (+ optional inject, Config)
├─ client.js          # optional browser half (see §4)
├─ locale/en.json     # {"meta":{"title":"…","description":"…"}}
└─ icon.svg           # optional; <=256 KiB, must stay inside the package
```

`package.json` minimum for a host-only bundle (`references/host-plugin.md:9-18`):

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Bundle resolution order (VERIFIED, `dsh-app-boot/lib/index.js:996-1002`): **dsh installation first, then the profile's `node_modules`** — so bundled `@deepseek-ai/*` packages need no dependency entry, but a third-party bundle must be installed in the profile.

Manual fallback (only if the GUI is unavailable; **INFERRED**, deliberately not run against the live profile):
append the package name to `dsh.profile.bundles`, add it under `dependencies`, run pnpm in the profile dir, then let HMR recompose (or restart the app). A pure-path variant also composes: an `insert` row whose `name` is an absolute path or `file:` URL is converted to a file URL by the patch loader (VERIFIED with `--dump-config`: `name: /tmp/dsh-plugin-probe/index.js` composed as `name: file:///tmp/dsh-plugin-probe/index.js`; supported at boot by `dsh-app-boot/README.md:66` "Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers"). That variant skips pnpm entirely but has no Plugins-page entry, so the GUI channel remains the recommended one.

## 3. Q3 — Does the running GUI see changes without a restart?

**Yes, for composition changes.** The desktop profile composes the HMR row and it is enabled:

```
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js '!ctx.get(''profileContext'')'
  config:
    root: []
```

(VERIFIED in the composed dump of a desktop-profile copy; `profileContext` is supplied by the desktop host, so the row is active. Note the profile `package.json` still carries the older `"patchReload": "live"` field — the 0.2.1 `dsh-app-boot` has no `patchReload` at all; HMR is a normal plugin row now. The legacy field is ignored/legacy.)

What HMR does (`dsh-hmr/README.md`):
- watches the profile manifest and both user patch files (profile + `~/.dsh/cordis.patch.yml`), re-reads the ordered bundle layers and recomposes on change;
- a changed `dsh.profile.bundles` list triggers a reload (that is exactly what install/remove cause);
- **"Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk. This covers installed packages below `node_modules` and the targets of linked packages."** → a linked local plugin's edited host code is picked up at the next recomposition even with `root: []`;
- because `root: []`, there is **no general filesystem watcher for source files**; nothing happens until a recomposition is triggered (a Plugin Manager action, a manifest/patch edit, a new install).
- replacement failure stops the old plugin and reports `failed` (loudly), not a silent restart.
- `pnpm`/package operations run outside the HMR lock.

For a **brand-new** bundle, install itself is the recomposition, so its host rows mount live (`application: applied`). The page still needs a **hard refresh (Cmd/Ctrl+Shift+R)** to pull the new client module graph — that is what the third-party `dsh-better-sidebar` README instructs after `dsh plugin add` ("hard-refresh the browser; client changes hot-load, only host-half updates need restart"), and the boot graph is injected at page load. **VERIFIED reading of shipped code + third-party instructions; not executed on the live GUI.**

## 4. Q4 — Client bundle: build step or plain ESM?

**No bundler is required for a hand-written client half.** The client-modules host serves the file that `exports["./client"]` resolves to (VERIFIED: `clientExportOf` resolves `exports["./client"]`, one-level conditional form accepted, `dsh-client-modules/lib/index.js:171-181`; served as `/plugins/<id>/client.js`). What it must be is the **lazy-CJS factory** format used by the shipped template and by real third-party plugins (`dsh-better-sidebar/lib/client.js` head is byte-for-byte the same pattern):

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-probe',            // must equal the package name
  factory(require) {
    const React = require('react');  // React/Cordis/UI libs come from the frozen platform table
    return { inject: ['slots'], apply(ctx) { /* ctx.slots.register(...) */ } };
  },
});
```

Rules (`references/ui-plugin.md`, `dsh-client-modules/README.md`):
- `package.json` needs `exports["./client"]`, `dsh.client.platform: "web"`, optional `dsh.client.inject` (service names the client half needs), optional `dsh.client.external` for non-baseline imports, optional `immediately: true`;
- the factory must be side-effect free; register styles/timers/listeners inside `apply` and return cleanups;
- missing/unreadable built bundle fails activation loudly with a build instruction; compiled TypeScript projects are expected to emit exactly this format (the repo's own `clientBundle` tsdown preset is not published — a third-party plugin "has to reproduce that build itself", i.e. hand-write the wrapper or configure tsdown accordingly);
- the module id equals the package name, so `<id>/client` and the bare id resolve to the same exports.

Client hot reload: `@deepseek-ai/dsh-client-hmr` is composed in the desktop profile (VERIFIED dump row `- id: client-hmr / name: '@deepseek-ai/dsh-client-hmr'`). It stat-polls each graph bundle (`pollIntervalMs` 500 default), serves `/plugins/events` SSE, and on a revision change prefetches, tears down the old fiber and remounts the plugin with fresh state — **no page reload**, but plugin-local React state is lost. A plain hand-edit of `client.js` is a content change, so it is detected like a rebuild (`dsh-client-hmr/README.md`). Not executed on the live GUI in this session.

## 5. Q5 — Rollback and rescue

Tier 1 — **normal removal** (GUI): Plugins → the bundle → switch **Off** (deselects the layer, keeps the dependency) or **Remove** (deselects, unloads, then `pnpm remove`; `dsh-plugin-manager/README.md` "Removal proceeds in order…"). HMR applies both; a removal of a bundle running since startup without HMR can report restart-required, but this profile has HMR.

Tier 2 — **manual repair with the app quit** (INFERRED, do only while the app is not running):
1. Back up: `cp -p ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/cordis.patch.yml /tmp/`.
2. Remove the package from `dependencies` **and** from `dsh.profile.bundles`; delete any rows you added to `cordis.patch.yml`.
3. Re-run pnpm in the profile dir (the app's bundled pnpm is `…/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`; a system pnpm `>=11` also works) and relaunch the app.
Never hand-edit `cordis.yml` (rewritten each boot) and never edit `~/.dsh/cordis.patch.yml` casually — it is the home layer and currently carries the `mcp-qieman` insert.

Tier 3 — **native fatal recovery (the app's own rescue)**: if a bad plugin prevents startup, the Electron startup-error dialog offers a third button **"Disable third-party plugins, back up profile patch, and restart"** (VERIFIED strings `lib/main.js:7339`, dialog wiring `lib/main.js:8320-8400`). It calls the launcher's `sanitizeProfile("dsh", profileDir, WEB_PROFILE.bundles)` (`lib/main.js:3532,3587`), which:
- renames the profile's `cordis.patch.yml` to a unique `cordis.patch.yml.bak-<epoch-millis>` sibling,
- restores the bundle list to the `web` template (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`),
- **preserves installed packages and every other manifest field**,
- leaves the home-level patch untouched; profile init recreates an empty patch on next launch.
Documented in `dsh-app-boot/README.md:70`. Re-enabling your plugin afterwards is just re-selecting the bundle (Plugins page) and reapplying its patch row.
CLI equivalent `dsh --profile rescue --from-default-profile web` exists only for CLI-owned profiles (0.1.5 help text); it cannot target `desktop`.

Precedent: `~/.dsh/backup-20261027/` is **session/workspace backups only** (`session-*.json.bak`, `workspace.json.bak`) — there is no prior plugin-patch backup. The native `.bak-<ts>` behaviour above is the real precedent for profile patches.

## 6. Version compatibility preflight (why a row can vanish silently)

- Runtime version for range checks is 0.2.1-rc.3. Rule (`dsh-app-boot/README.md:53-55`, `lib/index.js:252-336`): if the manifest declares `engines.dsh`, that range decides alone; otherwise **every** `peerDependencies` entry on `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` must match. Prereleases participate; empty/invalid ranges and `workspace:` ranges are incompatible; no declaration = no constraint.
- Effect: a denied ordinary row is turned into a detached `disabled: true` row **inside the launcher's copy only** — profile files are untouched, no patch audit trail; an incompatible *bundle* is skipped at load (`skippedBundles`) and printed once per start. From the user's view the plugin "just doesn't appear" — exactly what the `dsh-better-sidebar` README warns about ("whole row silently disabled"; 0.24.1 peers `^0.2.0-rc.1`, satisfied by 0.2.1-rc.3).
- Escape hatch: `compatibility.json` in the profile maps exact `package@version` → list of exact DSH versions. Grant via GUI/tool `set_version_exemption` (requires `acceptRisk: true` after an explicit warning) or `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version 0.2.1-rc.3 --accept-risk` (app CLI only). Not inherited across upgrades on either side.

## 7. Verification log (what was actually run)

- `dsh -V` → `0.1.5-rc.1`; `dsh plugin --profile desktop add file:/tmp/dsh-probe` and `dsh --profile desktop --dump-config` → both exit with `error: profile "desktop" is managed exclusively by the Electron application`. No profile writes (rejected during argument parsing).
- `defaults read /Applications/DeepSeek Harness.app/Contents/Info.plist CFBundleShortVersionString` → `0.2.1-rc.3`; `dsh/desktop-runtime.json` release → `{version: "0.2.1-rc.3", node: "24.21.0", pnpm: "11.28.5"}`.
- Composed the **real desktop profile files** in a throwaway `DSH_HOME=/tmp/dsh-probe-home` (copied `package.json` + `cordis.patch.yml`): `node /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile descopy --dump-config` → 1280-line composition containing `plugin-manager`, `hmr` (enabled via `profileContext`), `ui-plugin-manager`, `client-hmr`, `client-modules`; `dsh-better-sidebar` skipped because not installed in the copy. Only `/tmp` was written.
- Template/probe checks in `/tmp/dsh-plugin-probe`: `node --check client.js` OK; host `index.js` dynamically imports and exposes `apply`; patch YAML parses to `[{insert:[{id:'probe',name:'dsh-plugin-probe'}]}]`; a `--patch` overlay with an absolute-path `name` composed as `file:///tmp/…` (see §2).
- Read-only evidence: `/Users/lanlan/.dsh/profiles/desktop/.plugin-manager/logs/operation-nlfSFm/pnpm.log` (add `dsh-better-sidebar ^0.24.1`), `operation-rB6qDW/pnpm.log` (remove `dsh-plugin`), profile `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`.
- **Not executed** (to protect the live GUI): an actual GUI install, an installBundle through the tool, a client hot-swap. Those are marked accordingly above.

## Recommended development loop for this user

Numbered, copy-pasteable. Paths assume the plugin lives in `~/freedom/dsh-plugin-portfolio` (workspace). Steps marked **[V]** were verified in this session; **[U]** untested here, with why.

1. **[V] Never use the global CLI for desktop.** Do not run `dsh plugin --profile desktop …`, `dsh --profile desktop …` (0.1.5 rejects it anyway). All plugin management happens in the running app's **Plugins** sidebar page (composed as `ui-plugin-manager`, confirmed in the desktop composition).
2. **[V] Author the bundle in the workspace.** Copy the official template shape from `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/` (a throwaway extract of the app's `app.asar`; the live copy lives at `.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`, readable only by the Host process, not by `ls`/`cat`/ripgrep/node). Minimum files: `package.json` with `dsh.bundle.patch` (+ `dsh.client` and `exports["./client"]` only if you need UI), `cordis.patch.yml` with one `insert` row, `index.js` exporting `apply(ctx, config)`, optional `client.js` in lazy-factory form, `locale/en.json` with `meta.title`/`meta.description`, optional `icon.svg` ≤256 KiB.
3. **[V] Static checks before installing** (all work without the app):
   ```sh
   node -e "import('/Users/lanlan/freedom/dsh-plugin-portfolio/index.js').then(m=>console.log('apply:',typeof m.apply))"
   node --check /Users/lanlan/freedom/dsh-plugin-portfolio/client.js
   node -e "const y=require('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml');console.log(y.load(require('fs').readFileSync('/Users/lanlan/freedom/dsh-plugin-portfolio/cordis.patch.yml','utf8')))"
   ```
   Expect an `apply` function, `client.js syntax OK`, and the parsed `insert` array. Keep `name` in the insert row equal to the package name, and give every row a unique `id`.
4. **[U] Install through the GUI.** Sidebar → **Plugins** → **Add plugin** → arrow → **Install a third-party plugin** → enter the **absolute directory** `/Users/lanlan/freedom/dsh-plugin-portfolio` → **Install**. Expected sequence: `pluginManager.inspect` reads your `package.json` (name, version, `isBundle`), the dialog shows pnpm output, then a finished-install screen with **Enable now**. Untested here because it mutates the live profile while the user is working; the code path and payloads are verified (§1). Local-directory installs are links, so subsequent source edits reach the profile.
5. **[U] Confirm installation, host-first.** Plugins page: your bundle card appears under **Installed plugins**, on, with its rows; the row status dot goes **active**. If the card shows a problem tag, read it: `not-bundle` = missing `dsh.bundle.patch`; `incompatible-version` = §6; `failed` = the row's import/apply error. Verify the app wrote `/Users/lanlan/.dsh/profiles/desktop/.plugin-manager/logs/<op>/pnpm.log` and that `package.json` now lists the dependency plus the bundle name.
6. **[U] See the UI half.** Hard-refresh the page (Cmd+Shift+R) after the first install so it loads the new client bundle from the boot graph; afterwards, rebuilding/editing `client.js` is hot-swapped by `client-hmr` (~0.5–2 s poll) without a page reload. Untested here (no browser control; no page interaction performed).
7. **[U] Iterate.**
   - *Client half*: edit `client.js` → save → the plugin remounts in place (plugin-local React state is lost). If nothing happens, hard-refresh once; if the plugin's `apply` throws, the swap reports it visibly and retries on the next change.
   - *Host half*: edit `index.js` → force a recomposition, e.g. toggle your plugin's row **Off → On** in the Plugins page (writes `disabled:` to the profile `cordis.patch.yml` and recomposes) or switch the bundle off/on. HMR replaces plugins whose loaded files changed below the profile directory, including linked checkouts — no app restart (`dsh-hmr/README.md`). Untested live; fallback is quit-and-reopen of the app.
   - *Manifest/patch change* (new row, `dsh.client` change, new package name): editing `package.json`/`cordis.patch.yml` is observed by HMR and triggers a full recomposition; a changed `dsh.profile.bundles` list only triggers on manifest notifications, so re-select the bundle in the GUI if unsure.
8. **[U] Bump or reinstall.** With HMR, `installBundle` refuses a spec that is already a dependency (`already-installed`), so use the GUI's **Remove** then **Add plugin** again for a version change, or **Update** for official catalog entries. A version change is a removal + install; expect rows to stop, modules to be evicted, then the new ones to start.
9. **[V by code reading, U live] Rollback ladder.** (a) Plugins → **Off** (keeps package), then **Remove** (`pnpm remove`, deselect) — preferred. (b) If the app still boots but the page misbehaves: quit the app, back up `package.json` + `cordis.patch.yml` to `/tmp`, remove the dependency + bundle name + your patch rows, run pnpm in the profile dir, relaunch. (c) If the app will not start: use the startup-error dialog's **"Disable third-party plugins, back up profile patch, and restart"** — it renames the profile patch to `cordis.patch.yml.bak-<epoch-ms>` and resets the bundle list to base+web-app while preserving installed packages; then relaunch, re-select your bundle, re-add rows. (d) Home-layer mistakes (`~/.dsh/cordis.patch.yml`) are not covered by that rescue — restore from your own copy.
10. **[V] Keep DSH-version requirements honest.** Desktop runtime is 0.2.1-rc.3. Declare `engines.dsh` (or `@deepseek-ai/dsh-*` peers) compatible with `^0.2.0-rc.1` like `dsh-better-sidebar@0.24.1`, otherwise the launcher silently disables your rows at the next composition (no error in the UI) — check for detach by looking for your row in Settings → Plugins → **Plugin list** and by reading the app's stderr. For a deliberate mismatch: `compatibility.json` exact-version exemption (§6), granted from the GUI with an explicit risk acknowledgement.
11. **[V] Never** kill/restart the running app, edit `/Users/lanlan/.dsh/profiles/desktop/*` by hand while it runs, or point `dsh plugin --profile desktop` at it from the 0.1.5 CLI. If you need a scratch profile to test composition, use a throwaway `DSH_HOME` under `/tmp` (as done above: `DSH_HOME=/tmp/probe-home node /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile probe --from-default-profile web --dump-config`), never `~/.dsh`.
