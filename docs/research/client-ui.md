# DSH client-side plugin UI: how a web GUI panel is declared, loaded, and fed data

**Research target:** the "portfolio manager" plugin — a web GUI panel showing holdings, an allocation pie,
P&L and rebalance suggestions, with a refresh action.

**Ground truth version:** DSH **0.2.1-rc.3** (the Electron desktop app the user runs), extracted read-only to
`/tmp/dsh-asar`. Two source prefixes are used throughout:

| Prefix | Path | What it is |
|---|---|---|
| `$D` | `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai` | 306 real runtime packages of DSH 0.2.1-rc.3, extracted from `app.asar` (authoritative) |
| `$B` | `/Users/lanlan/.dsh/profiles/desktop/node_modules/dsh-better-sidebar` | `dsh-better-sidebar` **0.24.1**, a real third-party plugin whose `package.json` declares DSH support `^0.2.0-rc.1` (`$B/package.json:79-98`) — used as the working third-party precedent |

**Deliberately not used as authority:** the global npm install at
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` is **0.1.5-rc.2**, older than the desktop app. It was only
consulted for *published* type declarations (`dsh-package-manifest`, `dsh-client-ui-renderer` `.d.ts`) and is
marked `[npm-0.1.5]` wherever used.

**Labels:** `[V]` verified in code/artifacts; `[I]` inferred from verified facts (reasoning stated);
`[?]` unknown / could not verify.

---

## 0. TL;DR for the portfolio plugin

1. One npm package ships **both halves**: a host half (`main`, a Cordis plugin) and a browser half
   (`exports["./client"] → lib/client.js`). `package.json.dsh.client` names the client platform and the
   package-level load order (`$D/dsh-client-modules/README.md:34`). `[V]`
2. The host never "builds" your UI: it serves the file **byte-for-byte** at
   `/plugins/<package-name>/client.js`, and the browser executes it as a **classic script** that must call
   `window.__ModuleLoader__.load({ id, factory })` with `id === <package name>` and a factory that returns
   `{ apply, inject }`. No ESM, no JSX, no `import` statements. `[V]` (`$B/lib/client.js:1-6,23299-23300`;
   `$D/dsh-client-ui-schedule/lib/client.js:1-6,7544-7545`)
3. **You can hand-write that file — no bundler required.** The wrapper is 6 lines; module specifiers are
   resolved at runtime through the factory's `require` against the shell's frozen module table. `[V]`
   (skeleton in §8 was executed in a mocked loader).
4. The panel itself is a **React component registered into a named slot** with
   `ctx.slots.inject(name, () => ctx.slots.register(options, Component))`. For a full-page portfolio
   dashboard the right seats are the **keyed `main` slot + a `sidebar.panellist` icon with the same id**;
   DSH's own Plugins and Schedule pages use exactly this pair. `[V]` (`$D/dsh-client-ui-sidebar/README.md:38`,
   `$D/dsh-client-ui-schedule/lib/client.js:7473-7490`)
5. Live data: register a plain HTTP route in the host half
   (`ctx.webServer.register({ kind:'exact', path:'/portfolio/api/summary', handler })`) and `fetch()` it from
   the panel with a **relative URL**. This is the pattern the working third-party plugin uses in this exact
   desktop profile. `[V]` (`$B/src/index.ts:895-931`, `$B/src/client/api.ts:144`)
6. Styling: either the shell's design-system package `@deepseek-ai/dsh-client-ui-primitives` (a baseline
   module, importable from the bundle) or plain inline styles / one injected `<style>` tag. Design tokens are
   CSS variables (`var(--dsw-alias-…)`). `[V]` (`$B/src/client/ui/kit.tsx:20`, `$B/src/client/DiffTab.tsx:14`; §6)
7. Editing `lib/client.js` in place hot-swaps the running plugin in the open page via `dsh-client-hmr`
   (mtime/ctime/size polled every 500 ms) — **host-half changes still need a restart/reload**. `[V]`
   (`$D/dsh-client-hmr/README.md:30-48,42`)

---

## 1. Declaring a browser half

### 1.1 package.json contract

`$B/package.json` (a plugin that works on 0.2.x) shows every field that matters:

```json
{
  "name": "dsh-better-sidebar",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-modules"
      ],
      "platform": "web"
    },
    "manifestVersion": 1
  }
}
```

- `exports["./client"]` is the browser half; the host reads this export string and serves the file it points at
  (`$D/dsh-client-modules/lib/index.js:208` `comboUrl()` builds `/plugins/??…&rev=…`; `[V]`).
- `dsh.client.platform: "web"` — the Web consumer selects this row (`DshClientManifest.platform`,
  `$D`-equivalent published type in `[npm-0.1.5] dsh-package-manifest/lib/types/types.d.ts:39-52`). `[V for prose
  contract]` (`$D/dsh-client-modules/README.md:34`), `[npm-0.1.5 for the type]`.
- `dsh.client.inject` = **informational package-name dependencies**, not Cordis services: "ordered so dynamic
  providers load before their consumers" (`$D/dsh-client-modules/README.md:34`; DshClientManifest doc comment
  `[npm-0.1.5] …/types.d.ts:42-43`: *"Informational package-name dependencies, not Cordis service injection."*)
  `[V]`
- `dsh.client.external` = exact extra module-table requests beyond the baseline, including subpaths such as
  `@deepseek-ai/dsh-api-gateway/client` (`[npm-0.1.5] …/types.d.ts:46-51`; real uses in `$D`:
  `dsh-api-session-controller/package.json:47-49`, `dsh-api-remote-access/package.json`). `[V]`
- `dsh.client.immediately` = boot phase-one barrier (`types.d.ts:44-45`); only shell-internal packages
  (`dsh-client-modules`, `dsh-client-hmr`, `dsh-client-ui-renderer`) set it. Leave it out. `[V]`
- `dsh.bundle.patch` = the bundle-patch layer the CLI/profile launcher merges when the package is installed as a
  bundle (`DshBundleManifest.patch`, `types.d.ts:24-28`; `$B/cordis.patch.yml:1-12`). `[V]`
- `dsh.manifestVersion: 1` appears in `$B/package.json:57` but is **not** declared in the published
  `DshManifest` type (`types.d.ts:6-23`) and is not read by `dsh-client-modules`/`dsh-client-modules`-adjacent
  code. Treat as harmless/legacy; do **not** rely on it. `[V for absence]` `[? for any 0.2.1 consumer]`
- `type: "module"` + `main` are required for the **host** half to be importable as ESM by the Cordis loader
  (the loader imports the row's `name` as a package). `[V]` (`$B/package.json:5,13,15-19`; Cordis loader row
  `name: 'dsh-better-sidebar'`, `$B/cordis.patch.yml:39-42`)

### 1.2 The patch row that mounts both halves

One Loader entry mounts the package; the client half is discovered from that same entry — no second row:

```yaml
# $B/cordis.patch.yml:39-42
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
```

`id` is the Loader entry id (also used as the settings form namespace, `$B/src/context-types.ts:655-681`), `name`
is the exact installed package name. `[V]`

### 1.3 How the host serves and the browser executes the bundle

- The host half of `dsh-client-modules` scans enabled Loader entries and composes the boot graph
  `window.__DSH_BOOT__`; bundles are served under `/plugins`, grouped into combo URLs
  `/plugins/??<id>/client.js,…&rev=<rev>` and single-resource
  `/plugins/<id>/client.js` (`$D/dsh-client-modules/README.md:34,38,78`; `comboUrl()` at `$D/dsh-client-modules/lib/index.js:208`. `[V]`)
- The **artifact must already exist** — "The host serves built client bundles, so `pnpm run build` must have
  produced each `lib/client.js` before launch; a missing bundle fails activation loudly"
  (`$D/dsh-client-modules/README.md:52-54`). `[V]`
- Executing a bundle only registers a factory; "module bodies remain lazy and run only at first import or
  materialization" (`$D/dsh-client-modules/README.md:38`; lazy-CJS model at `:70-72`). `[V]`
- **Required artifact shape** (identical in first-party and third-party bundles):

```js
// $B/lib/client.js:1-3,23299-23300 (built by tsdown); same shape in
// $D/dsh-client-ui-schedule/lib/client.js:1-6,7544-7545
window.__ModuleLoader__.load({
  id: "dsh-better-sidebar",             // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // …require("react"), require("@deepseek-ai/dsh-client-ui-primitives"), …
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

  The bundle is a **classic script registering a lazy-CJS factory**, not an ES module: no top-level `import`,
  no `export`; externals are pulled with the injected `require` (e.g. `$B/lib/client.js:29
  let react = require("react")`). `[V]`
- `id` must be the package name because the module system keys rows by resolved package name and
  "`<id>/client` and the bare id resolve to the same exports" (`$D/dsh-client-modules/README.md:38`). `[V]`
- Dynamic `import()` in source compiles to `require.async("./client.<name>.js")` — sibling chunks are a
  bundler convention, served at `/plugins/<pkg>/client.<name>.js?rev=`; a hand-written plugin simply does not
  need them (`$D/dsh-client-modules/README.md:38,70`; chunk example `$B/src/client/chunk-loader.ts:1-70`). `[V]`

### 1.4 The frozen module table (what `require` can answer)

The shell seeds one static table; anything else must come from `dsh.client.external` or a boot-graph row
(`$D/dsh-client-modules/README.md:48-50`). Exact 0.2.1-rc.3 keys, read out of the GUI bundle
`$D/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` (search `"react/jsx-runtime":`; factory `OZ()`):

| Specifier | Notes |
|---|---|
| `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` | React 18 |
| `@deepseek-ai/cordis` | the vendored Cordis runtime |
| `zod`, `@tanstack/react-virtual` | added in the 0.2.x line |
| `@deepseek-ai/dsh-client-store` | `useSyncExternalStore`-style store helpers |
| `@deepseek-ai/dsh-client-ui-slots` | the slot registry the `slots` service comes from |
| `@deepseek-ai/dsh-client-ui-primitives` | the design system (Button, Modal, icons …) |
| `@deepseek-ai/dsh-client-ui-dockkit` | docking kit used by the right sidebar |

`[V]` (0.1.5-rc.2 had a subset: no `zod`, no `@tanstack/react-virtual` — `/opt/homebrew/.../dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`).

### 1.5 The `dsh-client-ui-slots` "missing package" — answered honestly

`@deepseek-ai/dsh-client-ui-slots` is **not an installed package in either tree**:

- `ls $D | grep slot` → nothing; the 306 desktop runtime packages contain no `dsh-client-ui-slots`.
- `ls /opt/homebrew/.../node_modules/@deepseek-ai | grep slot` → nothing (0.1.5-rc.2 either).
- It exists only as a **monorepo package compiled into the web shell**: it is a `devDependency` of
  `dsh-client-ui-renderer` (`$D/dsh-client-ui-renderer/package.json`, devDeps: `@deepseek-ai/dsh-client-ui-slots:
  0.2.1-rc.3`) and of every first-party client UI package, and its exports appear in the shell's
  `PLATFORM_MODULES` table (above). `[V]`

Consequences for plugin authors:

1. You never `import` slots at runtime — you use the **service** `ctx.slots` after declaring `inject:
   ['slots']` in the client plugin. `[V]` (`$B/src/client/index.tsx:49`; `$D/dsh-client-ui-schedule/lib/client.js:7365-7377`)
2. Its TypeScript types are not installable from npm in this version. The working third-party plugin solves
   this by **restating the service shape structurally** instead of importing it —
   `$B/src/context-types.ts:1-30` explains exactly this, and `:110-137` is the mirrored slot API type. `[V]`
3. Because the package is not on disk, the host *never* reports a missing bundle for it — the name is only a
   module-table key. `[V]` (`$D/dsh-client-modules/README.md:48-50`)

---

## 2. Client plugin shape (Cordis running in the browser)

The client half exports the same Cordis plugin vocabulary as the host half — `inject` (service-name array) and
`apply(ctx)` — **no default export** (`$B/README_EN.md:293`: "Organized per DSH official conventions (no default
export, dual client bundles)"; `$D/dsh-client-ui-sidebar/README.md:82`: "The `/client` exports are the plugin
body (`apply`/`inject`) plus the contract types only"). `[V]`

```js
// $D/dsh-client-ui-schedule/lib/client.js:7365-7377 (first-party, 0.2.1-rc.3)
const inject = [
  "slots",
  "locale",
  "remote",
  "remote.schedule",
  "conversation",
  "uiConversation",
  "uiWorkspace",
  "sessions",
  "workspaces",
  "sidebarRightTabs",
  "sidebarRight"
];
```

```ts
// $B/src/client/index.tsx:49 (third-party, declares 0.2.x support)
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection', 'remote', 'remote.session']
```

Notes verified from those call sites:

- **Service names, not package names.** `inject: ['slots']` (service) vs `dsh.client.inject:
  ['@deepseek-ai/dsh-client-ui-slots']` (package ordering). Both are needed for different reasons; they are not
  interchangeable. `[V]` (`$B/package.json:47-55` vs `$B/src/client/index.tsx:49`)
- **Nested service access must be declared.** `$B/src/client/index.tsx:29-44` documents that Cordis validates
  `ctx.get('remote').session` against the inject list; a missing entry throws
  `cannot get property "remote.session" without inject`. `[V]`
- **Disposal is `ctx.effect`.** Every registration must return its disposer to an effect so HMR / plugin
  disable tears it down (`$B/src/client/native/index.ts:249-260` collects disposers for exactly this; the
  settings slot registration at `$B/src/client/index.tsx:431-437` rides the fiber). `[V]`
- `apply(ctx)` receives the browser Cordis context; config (if any) arrives as the second parameter, mirroring
  the host half's `apply(ctx, config?)` (`$B/src/index.ts:761`). `[V]` `[I: client second arg]`
- Useful client services for this product: `slots`, `locale`, `sessions` (session list snapshot),
  `connection` (transport lifecycle), `remote` (typed RPC), `modules` (`import()` for lazy chunks),
  `sidebarRight` / `sidebarRightTabs` (right column), `uiWorkspace` / `uiConversation` (navigation). `[V]`
  (`$D/dsh-client-ui-schedule/lib/client.js:7365-7377`; `$B/src/context-types.ts:738-818`)

---

## 3. UI extension points: the slot system

### 3.1 The API

```js
// shape used by both first-party and third-party plugins
ctx.slots.inject(key, () => ctx.slots.register(options, Component))  // → disposer
```

- `inject(key, callback)`: runs the callback once **the slot declaration exists** (and re-runs it if the
  declaration is replaced). A no-op while the slot is undeclared — this is how a plugin can activate before the
  layout/sidebar entries that declare the slots. `[V]` (`$B/src/context-types.ts:129-136`; comment
  `$B/src/client/sidebar/bottom-toggle.tsx:14-18`)
- `register(options, component)` → disposer; options always include `name` (the slot key), plus slot-kind
  specific fields. Shared options seen in working code: `key`, `id`, `order`, `label`, `locale`, `inject`.
  `[V]` (`$B/src/context-types.ts:110-137`; call sites below)
- `options.inject(...args)` is a "business-face factory": its return object is merged into the component's
  props (e.g. `inject: (sessionId) => ({ ...injected, sessionId })`,
  `$B/src/client/native/index.ts:264-267`; `inject: () => ({ store, service })`, `$B/src/client/index.tsx:435`;
  `inject: () => ({...detail, taskBindings})`, `$D/dsh-client-ui-schedule/lib/client.js:7455-7462`). `[V]`
- Components additionally receive **standard props** injected by the renderer — for 0.2.1 these include
  `usePanelInfo`, `useSessions`, `useWorkspaces`, `useSessionStatus`, `useSessionAccess`, `useWorkspaceAccess`,
  `useResource`, `useRemoteAccess` (`$D/dsh-client-ui-layout`-declared slots; catalog `standardProps` for e.g.
  `main` / `sidebar.panellist`). `[V]` — this is how a panel reads "am I the selected panel"
  (`usePanelInfo`; `$D/dsh-client-ui-sidebar/README.md:38`).
- Slot **kinds**: `single` (one occupant), `list` (ordered entries with `id`/`order`/`label`), `keyed`
  (owner dispatches on a key you supply), `chain` (routing selector; first non-null `select(owner)` wins).
  `[V]` (slot catalog, §3.2)

### 3.2 The slot catalog (0.2.1-rc.3): 103 slots, machine-readable

The `dsh-cordis-client-runner` package embeds a generated catalog of **every slot the shipped web bundle
declares**, including kind, scope, registration options, owner props, who declares it, current occupants, and a
runnable example. Location: `$D/dsh-cordis-client-runner/lib/client.js`, region
`lib/types/client/slot-catalog.js` → extracted during this research to `/tmp/slots021b.json` (103 entries;
extraction script: parse the `CLIENT_SLOT_API` array literal, `eval` it, dump JSON). `[V]`

Root-scope slots most relevant to a portfolio dashboard:

| Slot | Kind | Why it matters |
|---|---|---|
| `main` | keyed | Central panel selected by sidebar entry id → **the dashboard page itself** |
| `sidebar.panellist` | list | Icons in the left sidebar's global panel list; `id` selects the `main` entry |
| `settings.section` | list | One settings page per entry (`id`, `order`, `label`) |
| `shell.bottom` | single | Full-width band below all three columns |
| `shell.overlay` | list | Frame-wide floating layer above every column |
| `sidebar.footer.action` | list | Extra sidebar-foot actions |
| `settings.general.item` | list | One preference row without a page of its own |
| `plugins.*` (10 slots) | mixed | Extend DSH's own plugin manager pages |

Session-scope slots worth knowing: `sidebar.right.pane.tab` / `.title` (right-sidebar tab body, keyed by the tab
type id), `conversation.session.header.utilities` (header button row), `conversation.input.dock` (composer dock),
`conversation.chat.turnTail` (per-turn footer), `sidebar.session.row.leading` (session-row decoration).
`[V]` (`/tmp/slots021b.json`; source paths recorded per entry, e.g.
`packages/client/ui-layout/src/client/index.ts:73` for `main`, `packages/client/ui-sidebar/src/client/contract/slots.ts:32`
for `sidebar.panellist`).

### 3.3 The recommended pattern: full-page panel (`main` + `sidebar.panellist`)

DSH's own Schedule page registers exactly this pair (0.2.1-rc.3):

```js
// $D/dsh-client-ui-schedule/lib/client.js:7473-7490
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main",
  key: PANEL_ID,
  locale: MANAGER_NS,
  inject: () => ({ ...detail, onNewTask: () => { ctx.uiWorkspace.startSession(); } })
}, TaskManagerPage));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,
  order: 10,
  locale: MANAGER_NS,
  label: () => t("panel")
}, TaskManagerIcon));
```

The contract: "Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional
`order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's
root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection."
(`$D/dsh-client-ui-sidebar/README.md:38`). `[V]`

### 3.4 Right-sidebar tab (alternative / secondary surface)

Two stages, both inside `ctx.effect` (`$D/dsh-client-ui-sidebar-right/README.md:81-84`): `[V]`

```js
// 1) the tab TYPE
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-plugin-portfolio',        // unique; package name is the natural value
  kind: 'portfolio',                 // page type: opened by kind via ctx.sidebarRight.openTab('portfolio')
  title: () => 'Portfolio',
  // patterns?: string[]  — only for dsh-resource:// viewer types
  // priority?: 'extension' | 'builtin' | 'fallback'
}), 'portfolio: tab type')

// 2) the BODY, keyed by the type id
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: 'dsh-plugin-portfolio' },
  PortfolioTabBody,
))
```

The body reads `{ sidebar, panel, tab }` through the framework-injected `useTabInfo()`; `ctx.sidebarRight.openTab(kind)`
expands the column and opens it (`$D/dsh-client-ui-sidebar-right/README.md:84,93`). `[V]` The working third-party
plugin registers its tabs the same way (`$B/src/client/native/index.ts:264-278`). `[V]`

### 3.5 A third option: a settings page

`settings.section` (list, root scope) gets `id`, `order`, `label` and receives `{ close }` as owner props
(`/tmp/slots021b.json` entry `settings.section`; built-in occupants: `account`, `general`, `models`,
`plugins`, `agent-presets`). Cheap to add, but it lives behind Settings, not in the main navigation — a poor
primary surface for the portfolio panel. `[V]`

> Third-party alternative: if `dsh-better-sidebar` is installed, it additionally exposes its own
> `ctx.betterSidebar` service with `registerTab(descriptor)` / `registerFileViewer(...)`
> (`$B/src/client/service.ts:476-479`; consumer snippet in `$B/README_EN.md:322-330`). This is **plugin-specific**,
> not part of DSH, and should not be a dependency of the portfolio plugin.

---

## 4. Reading live data from the host

### 4.1 Option A (recommended, verified in the running desktop profile): host route + relative `fetch`

The third-party plugin that is installed in this exact desktop profile does this:

```ts
// $B/src/index.ts:895-931 (host half) — every route rides an effect so it unregisters with the plugin
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/sidebar/api',
  handler: async (req, res) => {
    if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return }
    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return } // abridged
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.slice('/sidebar/api/'.length)
    try { writeOk(res, await api[method](await readJsonBody(req))) } catch (error) { writeError(res, error) }
  },
}), 'dsh-better-sidebar: /sidebar/api routes')
```

```ts
// $B/src/client/api.ts:140-150 (browser half)
response = await fetch(`/sidebar/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, cwd }),
})
```

- Route shape: `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })` returns a
  disposer. Matching is "exact over the whole table, then longest prefix, then the fallback handler"; duplicate
  paths throw (`$D/dsh-host-webserver/README.md:61`). `handler` receives the raw Node request/response (the
  structural mirror the third-party plugin uses is `$B/src/context-types.ts:62-79`: `req.url/method/headers`,
  `res.statusCode/writeHead/end`). `[V]`
- The host half declares `inject: ['webServer', …]` (`$B/src/index.ts:91`). `[V]`
- **Relative URLs work because the page is served over HTTP by the same host** — the GUI in this session is at
  `http://127.0.0.1:57267`, so `/portfolio/api/summary` is same-origin and hits the plugin route. For static
  (`file://`) desktop pages a shell-owned carrier bridges fetch (`$D/dsh-client-connection/README.md:30` and
  `$D/dsh-host-webserver/README.md:12`: "It serves browsers only; Electron loads dist over `file://` and
  carries fetch over an IPC bridge"). `[V for http; I for the file:// bridge details]`
- **Trust fence (recommended):** the `/api` gateway and this working plugin reject requests whose `Host` header
  is neither loopback nor in `ctx.webRuntime.trustedHosts`; it is a DNS-rebinding/cross-site defense, not
  authentication (`$B/src/trust-fence.ts:1-30`; usage `$B/src/index.ts:763-767`). For a local single-user MVP it
  can be omitted, but copying the fence is cheap if the plugin ever binds to a LAN interface. `[V]`
- Refresh model: plain `fetch` on mount + a button (and/or `setInterval`) — there is no framework store to
  integrate with; React state is enough. `[V]` (skeleton §8)

### 4.2 Option B: typed RPC via `ctx.remote` (exists, heavier)

First-party surfaces use generated Typert RPC remotes (`ctx.remote.schedule.list(...)`,
`$D/dsh-client-ui-schedule/lib/client.js:6297-6302`), delivered by `@deepseek-ai/dsh-api-gateway`, which
requires host-side `TypertRemoteService` classes, `@Remote`-decorated methods and **generated invocation
descriptors** (`$D/dsh-api-gateway/README.md:27,56-58`). The client gets `ctx.remote` by importing
`@deepseek-ai/dsh-api-gateway/client` and declaring it under `dsh.client.external`/`inject`
(`$D/dsh-api-session-controller/package.json:41-52`). This buys validation, cancellation and streams, but costs
a build-time codegen step — **not recommended for the MVP**. `[V]` `[I on effort]`

### 4.3 Where to persist holdings

Out of scope here (host-api task). Note only: host half can read/write files or use `ctx.settings` /
profile entry config; plugin mount-row `config` is the settings surface
(`$B/src/context-types.ts:655-681`). `[V for the mechanism]`

---

## 5. Build pipeline — and the no-build escape hatch

### 5.1 What the shipped packages use

- First-party and third-party packages build with **tsdown** (rolldown): `$B/package.json:216-220`
  (`"build": "… tsc -p tsconfig.build.json && tsdown"`, `"bundle": "tsdown"`, `"watch": "tsdown --watch"`),
  `devDependencies: "tsdown": "^0.22.2"`. `[V]`
- The emitted artifact is the `window.__ModuleLoader__.load({…})` script shown in §1.3; CSS modules are compiled
  into JS constants and injected as `<style data-plugin-css="…" data-plugin="<pkg>">` on materialization
  (`$B/lib/client.js:1594-1604`). `[V]`
- `import()` in source becomes `require.async("./client.<name>.js")`; the shared DSH tsdown preset "stamps
  `lib/client.js` after all package-local chunks are written" (`$D/dsh-client-hmr/README.md:30-36`;
  `$D/dsh-client-modules/README.md:38`). `[V]` **The preset itself is not published** as a package in the
  extracted runtime (`ls $D | grep -i build` → none); replicate the wrapper manually or copy it. `[V]`

### 5.2 The wrapper is small enough to hand-write — verified

A hand-written `lib/client.js` (6-line wrapper + a factory that calls `require("react")`) is a valid artifact:

- The host does not parse or transform the file on the way out — combo/single responses are the file bytes with
  source-map trailers stripped (`$D/dsh-client-modules/lib/index.js`, combined response body described at `$D/dsh-client-modules/README.md:78`). `[V]`
- The browser executes it as a script and the loader registers the factory; resolution happens inside the
  factory through `require` (`seed → memoized → boot-graph row → factory`; miss throws
  `client-modules: require("…") missed the module table`, `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js:308`
  in the published 0.1.5 copy; same contract described at `$D/dsh-client-modules/README.md:70-72`). `[V]`
- Executed during this research: the skeleton's `lib/client.js` was loaded with a stubbed
  `window.__ModuleLoader__` and stubbed `require`, then `apply(ctx)` was called with a fake Cordis ctx — it
  registered both slots and rendered the panel and icon components (`/tmp/test-client.mjs`). `[V]`
- The skeleton's host half was imported as ESM and exercised the same way — `inject: ['webServer']`, route
  registered, handler returned JSON (`/tmp/test-host.mjs`). `[V]`

**Recommendation for the portfolio plugin:** start hand-written (fast loop, zero toolchain), and only adopt
tsdown when you want CSS modules, TSX or lazy chunks.

---

## 6. Styling

Three viable approaches, all verified as available in this shell:

1. **Design system package** (preferred for native look): `@deepseek-ai/dsh-client-ui-primitives` is a baseline
   module-table entry (§1.4) and is imported directly by the working third-party plugin, e.g.
   `import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'` and
   `import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'`
   (`$B/src/client/` imports, lines 14/17/20/26/51 of those modules; also `require("@deepseek-ai/dsh-client-ui-primitives")`
   at `$D/dsh-client-ui-schedule/lib/client.js:8-9`). No `dsh.client.external` entry is needed — it is baseline.
   The exact export surface is not documented in the extracted tree, so check names at build time. `[V for
   availability]` `[? for full export list]`
2. **Inline styles + design tokens** (safest MVP): theme values are CSS variables such as
   `var(--dsw-alias-brand-primary, …)`, `var(--dsw-alias-label-primary)`, `var(--dsw-alias-state-success-primary)`
   — visible in the third-party plugin's compiled CSS (`$B/lib/client.js:1594-1600`). Inline
   `style={{ color: 'var(--dsw-alias-label-primary, inherit)' }}` costs nothing and follows light/dark themes.
   `[V]`
3. **Inject one `<style>` tag** from `apply()` for richer CSS:
   ```js
   const css = `.portfolio-panel { padding: 16px 20px; }`
   ctx.effect(() => {
     const tag = document.createElement('style')
     tag.textContent = css
     document.head.appendChild(tag)
     return () => tag.remove()
   }, 'portfolio: styles')
   ```
   This mirrors exactly what the compiled bundles do (`<style data-plugin-css=… data-plugin=…>`,
   `$B/lib/client.js:1599-1604`); key it on your package to stay HMR-idempotent. `[V for pattern]`

Avoid assuming Tailwind or any global class names: the shell ships its own CSS (`$D/dsh-web-frontend/dist/assets/index-*.css`,
`vendor-*.css`); plugin CSS is expected to be self-contained. `[I]`

---

## 7. Dev loop / reload rules

- **HMR watches the built entry artifact, not sources.** Revisions come from the file's `mtimeMs`,
  `ctimeMs` and size (no hashing; `$D/dsh-client-modules/README.md:78`), polled every `pollIntervalMs`
  (default **500 ms**; `$D/dsh-client-hmr/README.md:42`); a changed artifact emits a `rebuilt` frame over the
  `/plugins/events` SSE channel, the page invalidates + prefetches the new module, tears down the old fiber,
  removes its styles and re-runs `apply` (`$D/dsh-client-hmr/README.md:30-36,64-70,116`). The shipped Web
  composition mounts this transport (`:28`); the desktop profile exhibits the same behaviour in practice
  ("DSH hot-reloads client changes; only host-half updates need a restart", `$B/README_EN.md:90`), though
  `dsh-client-hmr` itself notes "Web transport only — Electron installation and backend restart handling do not
  use this SSE path. Entry reconciliation itself is transport-independent" (`:118`). `[V for web]` `[? for exact
  Electron carrier]`
- So: **rewrite/touch `lib/client.js` → the panel swaps in the open page, no restart, no page refresh** — with
  the caveat that the reload is coarse: "a fresh fiber and fresh components; React state inside the reloaded
  plugin is lost" (`$D/dsh-client-hmr/README.md:48,116`). `[V]`
- **Host-half changes need a host restart / plugin reload** — the HMR transport is client-entry only; the
  third-party README states the same split ("DSH hot-reloads client changes; only host-half updates need a
  restart", `$B/README_EN.md:90`). `[V]`
- Chunk-only rebuilds need the shared tsdown preset (it re-stamps `client.js`); with a hand-written single file
  this problem does not exist. `[V]` (`$D/dsh-client-hmr/README.md:30-36`)
- Where the file must physically live for the desktop profile to pick it up (dependency + bundle row +
  `pnpm install`) is covered by `research/dev-loop.md`; this doc only claims the **artifact contract**.

---

## 8. Minimal working client plugin skeleton

Complete, copy-pasteable, **both halves verified** by executing them in a mocked module loader / fake Cordis
context (`/tmp/test-client.mjs`, `/tmp/test-host.mjs`). Directory:

```
dsh-plugin-portfolio/
├─ package.json
├─ cordis.patch.yml
└─ lib/
   ├─ index.js     # host half: Cordis plugin + one HTTP route
   └─ client.js    # browser half: hand-written bundle, no build step
```

### 8.1 `package.json`

```json
{
  "name": "dsh-plugin-portfolio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

(`dsh.client.inject` lists the packages that own the `main` / `sidebar.panellist` slots, for load ordering;
`slots.inject` in the bundle also waits for the declarations, so this is advisory. `dsh.manifestVersion` is
intentionally omitted — see §1.1.)

### 8.2 `cordis.patch.yml`

```yaml
# dsh.bundle.patch layer: one loader row mounts BOTH halves.
# `id` = Loader entry id; `name` = installed package name, exactly.
- insert:
    - id: portfolio
      name: 'dsh-plugin-portfolio'
```

### 8.3 `lib/index.js` — host half

```js
// Host half: a plain Cordis plugin (named exports, no default export).
export const name = 'dsh-plugin-portfolio'

// Cordis service names, NOT package names.
export const inject = ['webServer']

// Placeholder data source; replace with the real ledger.
const holdings = {
  totalValue: 128430.55,
  currency: 'CNY',
  updatedAt: '2026-10-28T07:00:00.000Z',
  positions: [
    { symbol: '510300', name: '沪深300ETF', weight: 0.42, pnl: 0.083 },
    { symbol: '110011', name: '易方达优质精选', weight: 0.33, pnl: -0.021 },
    { symbol: '000001', name: '现金', weight: 0.25, pnl: 0 },
  ],
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/portfolio/api/summary',
        handler: (req, res) => {
          const body = JSON.stringify({ ok: true, value: holdings })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }),
    'portfolio: /portfolio/api/summary route',
  )
}
```

### 8.4 `lib/client.js` — browser half (hand-written, no bundler)

```js
// Browser half: hand-written, NO build step. The host serves this file as a
// classic script at /plugins/dsh-plugin-portfolio/client.js; executing it only
// REGISTERS a factory, so nothing below runs until the plugin is materialized.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-portfolio', // must equal the package name
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react') // a PLATFORM_MODULES seed word
    const h = React.createElement

    const PANEL_ID = 'portfolio'

    // Cordis service names required before apply() runs.
    const inject = ['slots']

    const panelStyle = { padding: '16px 20px', color: 'var(--dsw-alias-label-primary, inherit)' }
    const buttonStyle = { marginTop: 12, padding: '4px 12px', cursor: 'pointer' }

    /** Full-page panel registered into the keyed `main` slot. */
    function PortfolioPanel() {
      const [state, setState] = React.useState({ status: 'loading' })
      const load = React.useCallback(() => {
        setState({ status: 'loading' })
        fetch('/portfolio/api/summary', { credentials: 'same-origin' })
          .then((res) => res.json())
          .then((payload) => setState({ status: 'ready', value: payload.value }))
          .catch((error) => setState({ status: 'error', error: String(error) }))
      }, [])
      React.useEffect(() => {
        load()
      }, [load])

      const body =
        state.status === 'loading'
          ? h('p', null, 'Loading holdings…')
          : state.status === 'error'
            ? h('p', null, 'Failed to load: ' + state.error)
            : h(
                'div',
                null,
                h('p', null, 'Total value: ' + state.value.totalValue + ' ' + state.value.currency),
                h('p', null, 'As of: ' + state.value.updatedAt),
                h(
                  'ul',
                  null,
                  state.value.positions.map((position) =>
                    h('li', { key: position.symbol }, position.name + ' — ' + Math.round(position.weight * 100) + '%'),
                  ),
                ),
              )

      return h(
        'section',
        { style: panelStyle },
        h('h2', { style: { margin: '0 0 8px' } }, 'Portfolio'),
        body,
        h('button', { style: buttonStyle, onClick: load }, 'Refresh'),
      )
    }

    /** Icon in the left sidebar's global panel list (owner props: size, active). */
    function PanelIcon(props) {
      return h('span', { 'aria-hidden': true, style: { fontSize: props.size, opacity: props.active ? 1 : 0.7 } }, '◔')
    }

    /** Client plugin body. */
    function apply(ctx) {
      // `slots.inject` defers registration until the slot's declaration exists
      // (the layout/sidebar entries may activate after this plugin) and re-runs
      // if that declaration is replaced. Both disposers ride the plugin fiber.
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, PortfolioPanel),
          ),
        'portfolio: main panel',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Portfolio' }, PanelIcon),
          ),
        'portfolio: sidebar nav icon',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

**What this gives you:** a "Portfolio" row/icon in the left sidebar's global panel list; selecting it renders the
`main` panel, which fetches `/portfolio/api/summary` on mount and on every **Refresh** press. Look-and-feel is
theme-aware via CSS variables; no build step, no dependencies to install.

**Verify it yourself without the GUI:**

```sh
node --check lib/client.js && node --check lib/index.js
# mocked-loader + fake-ctx harness used in this research: /tmp/test-client.mjs, /tmp/test-host.mjs
node /tmp/test-client.mjs   # → main + sidebar.panellist registrations, panel renders
node /tmp/test-host.mjs     # → exact route /portfolio/api/summary, 200 JSON
```

**Known gaps before shipping:** replace the inline placeholder data with a real source and a persisted store;
register a chart (SVG/canvas inline — no chart library is in the baseline module table, so bundle it or they
must be a `require.async` chunk via a build); optionally add a trust fence (§4.1) and i18n via
`inject: ['locale']` + `ctx.locale.register(ns, lang, dict)` (`$B/src/context-types.ts:602-609`). How to install
this package into the desktop profile is in `research/dev-loop.md`.

---

## Appendix A — claim → evidence index

| Claim | Evidence |
|---|---|
| Client half declared by `dsh.client` + `exports["./client"]` | `$D/dsh-client-modules/README.md:34`; `$B/package.json:15-27,43-58` |
| Served at `/plugins/<id>/client.js`, combos with `rev` | `$D/dsh-client-modules/README.md:38,70`; `$D/dsh-client-modules/lib/index.js:208`; `$D/dsh-client-modules/README.md:78` |
| Artifact is a classic script calling `window.__ModuleLoader__.load` | `$B/lib/client.js:1-6`; `$D/dsh-client-ui-schedule/lib/client.js:1-6` |
| Artifact exports `apply` / `inject`, no default export | `$B/lib/client.js:23299-23300`; `$D/dsh-client-ui-schedule/lib/client.js:7544-7545`; `$B/README_EN.md:293`; `$D/dsh-client-ui-sidebar/README.md:82` |
| Must build before launch / host serves bytes | `$D/dsh-client-modules/README.md:52-54`; `$D/dsh-client-modules/README.md:78` |
| Frozen module table contents (0.2.1) | `$D/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` (`"react/jsx-runtime":` literal); `sharedPackages` in `/tmp/dsh-asar/dsh/desktop-runtime.json` |
| `external` adds non-baseline specifiers | `$D/dsh-api-session-controller/package.json:41-52`; `[npm-0.1.5] dsh-package-manifest/lib/types/types.d.ts:39-52` |
| Slots API `inject` + `register(options, Component)` | `/tmp/slots021b.json` examples; `$B/src/context-types.ts:110-137`; call sites `$B/src/client/index.tsx:431`, `$B/src/client/native/index.ts:264` |
| 103 slots, kinds, per-slot options/props, occupants | `/tmp/slots021b.json` ← `$D/dsh-cordis-client-runner/lib/client.js` region `lib/types/client/slot-catalog.js` |
| `main` + `sidebar.panellist` panel pattern | `$D/dsh-client-ui-sidebar/README.md:38`; `$D/dsh-client-ui-schedule/lib/client.js:7473-7490` |
| Right-sidebar tab = type + body slots | `$D/dsh-client-ui-sidebar-right/README.md:81-84,93`; `$B/src/client/native/index.ts:264-278` |
| Host HTTP route API + Electron bridge | `$D/dsh-host-webserver/README.md:12,61`; `$D/dsh-client-connection/README.md:30` |
| Relative `fetch` to plugin route | `$B/src/index.ts:895-931`; `$B/src/client/api.ts:144` |
| Trust fence | `$B/src/trust-fence.ts:1-30`; `$B/src/index.ts:763-767` |
| HMR watches artifact mtime/ctime/size, 500 ms, coarseness | `$D/dsh-client-modules/README.md:78`; `$D/dsh-client-hmr/README.md:30-36,42,48,64-70,116` |
| CSS injected via `<style data-plugin-css>` | `$B/lib/client.js:1594-1604` |
| Design-system specifier is baseline | PLATFORM_MODULES (§1.4); `$B` primitives imports; `$D/dsh-client-ui-schedule/lib/client.js:8-9` |
| `@deepseek-ai/dsh-client-ui-slots` is not installed; bundled into the shell | `ls $D | grep slot` → none; `$D/dsh-client-ui-renderer/package.json` devDeps; `PLATFORM_MODULES` |

## Appendix B — open questions / risks

1. **Electron transport specifics (`file://` + IPC bridge vs the HTTP GUI URL).** The GUI in this session is
   `http://127.0.0.1:57267`, where relative fetch is plainly same-origin. The extracted tree does not contain
   the Electron main/preload code, so the `file://` bridge is documented from READMEs only. `[I]`
2. **`dsh.manifestVersion`** — accepted in the wild (`$B/package.json:57`) but absent from the published
   manifest type and not read by modules/runner. Harmless, probably legacy. `[?]`
3. **`@deepseek-ai/dsh-client-ui-primitives` export list** — not documented in the extracted tree; confirm names
   before depending on them, or stay on inline styles. `[?]`
4. **No published tsdown preset** for the `__ModuleLoader__` wrapper; hand-writing or copying the 6-line wrapper
   is the pragmatic route (the compiled first/third-party bundles are exact templates). `[V for absence]`
5. **Slot type definitions** for external plugins are not installable (§1.5); mirror them structurally like
   `$B/src/context-types.ts` or drop to plain JS. `[V]`
