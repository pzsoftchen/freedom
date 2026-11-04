# DSH host-side plugin API (tools, HTTP routes, persistence)

Researched for: **portfolio-manager** plugin — (a) agent-callable tools that record/read holdings and
compute allocation / risk / rebalance output, (b) data exposed to a React panel in the web GUI,
(c) durable holdings storage.

Authoritative target: **DeepSeek Harness desktop 0.2.1-rc.3** (`CFBundleShortVersionString` of
`/Applications/DeepSeek Harness.app/Contents/Info.plist`). The global npm install
(`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`, 0.1.5-rc.2) is **wrong for this user** and is not
cited below.

## 0. Sources, and one important caveat

Path shorthands used throughout:

| Shorthand | Absolute path |
| --- | --- |
| `RT` | `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai` (0.2.1-rc.3 packages extracted verbatim from `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` → `dsh/node_modules/@deepseek-ai`) |
| `SIDEBAR` | `/Users/lanlan/.dsh/profiles/desktop/node_modules/dsh-better-sidebar` (real third-party plugin v0.24.1, peer-depends on `@deepseek-ai/*` `^0.2.0-rc.1`, installed and mounted in the live desktop profile) |

Every `RT/...` file below is byte-identical to the file inside `app.asar`; I read the asar header
directly (`/tmp/host-api-asar/dump-asar.mjs`) because `/tmp/dsh-asar` is a teammate's extraction of the
same archive.

**Caveat — no `.d.ts` in the app image.** The shipped `app.asar` contains only compiled ESM
(`lib/*.js`) plus `README.md`/`README.zh.md`; there are no `lib/types/*.d.ts` files. Verified:
`grep -c "lib/types/index.d.ts" /tmp/host-api-asar/asar-files.txt` → 0, and `RT/dsh-tools/lib/`
contains `index.js` + `lib/types/*.js` only. Consequences:

* API contracts below are quoted from the **0.2.1-rc.3 READMEs** (`RT/*/README.md`) and the
  **compiled implementation** (`RT/*/lib/**/*.js`, which retains the original JSDoc comments).
* Exact TS interface text is *reconstructed*, not copied from a published declaration file. Plugin
  authors **do** get real `.d.ts` from npm: `SIDEBAR/package.json:139` pins
  `@deepseek-ai/dsh-tools: 0.2.0-rc.1` etc. as devDependencies, so install the matching version from
  the registry as a devDependency for compile-time types.
* Anything I could not verify is called out in §7.

## 1. Cordis plugin shape (what the loader mounts)

DSH is Cordis 4 (`RT/dsh/package.json` depends on `@deepseek-ai/cordis` **4.0.5**). A Cordis plugin is
a function, or an object with named exports; the loader additionally understands `name`, `inject`,
`Config`, `reusable`. Minimal contract (`RT/cordis/README.md:18-65`):

```ts
import { Context, Service } from 'cordis'

const greeter = Object.assign((ctx: Context) => {
  ctx.on('app/ready', () => { /* ... */ })
}, {
  inject: ['counter'],   // services that must exist before this plugin runs
})

await root.plugin(greeter)   // returns a Fiber; effects/listeners unwind on dispose
```

`inject` "tells Cordis which services must exist before the plugin runs"; effects, event listeners and
services are removed when their owning fiber is disposed (`RT/cordis/README.md:65-67`). The loader
passes validated config as the second `apply` argument.

The real third-party host half is the best current reference:

```ts
// SIDEBAR/src/index.ts:76
export const name = 'dsh-better-sidebar'

// SIDEBAR/src/index.ts:91
export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']

// SIDEBAR/src/index.ts:761
export function apply(ctx: Context, config?: SidebarConfig): void { /* ... */ }

// SIDEBAR/src/index.ts:54 — re-export the schemastery schema as the loader-row Config
export { Config }
```

### Config schema (schemastery, from `@deepseek-ai/schemastery` 3.18.5)

`RT/schemastery/package.json` → version `3.18.5`. Import the DSH build, not the public package — this
is load-bearing for live settings writes (`SIDEBAR/src/config.ts:1-14`):

```ts
// SIDEBAR/src/config.ts:15, 145
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  ...LimitsSchema.dict,          // readLimit/mediaLimit/... plain fields → remount on change
  ...volatilePrefs,              // user prefs marked `.volatile()` → live-committed, no remount
}) as z<SidebarConfig & SidebarPrefs>
```

Rules extracted from `SIDEBAR/src/config.ts:100-140`:

* A **volatile** field (`.volatile()`) is committed into the running fiber
  (`loader/volatile-update`) instead of remounting the plugin; ordinary fields keep remount semantics.
* `.volatile()` **returns a copy** of the schema, so results must be collected into an object (calling
  it for side effects leaves every field non-volatile).
* Only DSH's schemastery build wraps a volatile field in a cosmokit `Volatile` reference that the
  loader can commit; the public `schemastery` package "silently drops every live preference write"
  (`SIDEBAR/src/config.ts:5-12`).

`ctx.effect(fn, label)` registers a disposer against the plugin fiber; the returned disposer of
`ctx.webServer.register(...)` / `ctx.tools.register(...)` is typically wrapped in it
(`SIDEBAR/src/index.ts:895`, `:932`, `:1117`).

## 2. Registering an agent-callable tool

Service: `ctx.tools` (`RT/dsh-tools/lib/index.js:2975` `register(definition)`). "Registering a tool is
enough to make it visible — the registry feeds its schemas into the system-prompt assembly
automatically" (`RT/dsh-tools/README.md:31`). Per-agent narrowing uses `agent.ctx`
(`RT/dsh-agent/README.md:61-63`); `ctx.tools.restrict({allow,deny})` masks globals per agent scope
(`RT/dsh-tools/README.md:86`).

### 2.1 The documented call

```ts
// RT/dsh-tools/README.md:39-63 (verbatim)
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

### 2.2 What `defineTool` accepts and what it returns

`defineTool` wraps the author options into a registry-ready definition
(`RT/dsh-tools/lib/index.js:839-889`). Fields, from the implementation:

| Field | Required | Notes (evidence) |
| --- | --- | --- |
| `name` | yes | unique; `run_code` is reserved and cannot be registered/shadowed (`lib/index.js:2982`) |
| `description` | yes | model-facing; the ONLY prose the model sees besides descriptions of parameters |
| `parameters` | yes | DSL map; every property is an implicit open object root (`README.md:49-52`); `required: true` marks required |
| `output.schema` | yes | raw JSON Schema subset enforced against the returned canonical value |
| `output.render(args, value)` | yes | pure projection to `ContentBlock[]` — this is what the model/transcript sees |
| `output.presentationMeta?(args, value)` | no | pure, replayable metadata persisted on `tool/result` for Host/Client renderers |
| `execute(args, exec)` | yes | returns only the canonical JSON value declared by `output.schema` |
| `timeoutMs?` | no | must be a positive finite number (`lib/index.js:848`); declarative only |
| `deferLoading?` | no | 0.2.x addition: only `true` is retained (`lib/index.js:865`); kept in schema projection (`:3144`); does not imply an addition record (`RT/dsh-tools/README.md:240`) |
| `isConcurrencySafe?(args)` | no | only an exact `true` opts the call into a parallel group (`lib/index.js:887`) |
| `finalizeContent?` / `projectContent?` | no | last-mile content transforms (`README.md:92`) |
| `presentCall?` / `presentResult?` | no | Host-local presenters; the shipped Web client derives props itself (`README.md:96`) |

An invalid definition fails **at registration**, not at call time:

```js
// RT/dsh-tools/lib/index.js:2975-2983
register(definition) {
  const name = definition.name
  const output = definition.output
  if (output === void 0 || typeof output !== 'object' || typeof output.render !== 'function' || ...)
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
  assertSupportedJsonSchema(output.schema)
  ...
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: 'tools.register()' })
}
```

### 2.3 Return value: text vs structured data, and validation

`execute` must return **only** the canonical lossless-JSON value. The registry snapshots it, validates
it against `output.schema`, deep-freezes it, then calls `render` to produce model content:

```js
// RT/dsh-tools/lib/index.js:3636-3652 (createSuccessResult)
const detached = snapshotToolValue(tool.name, candidate)
const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
const value = deepFreeze(detached)
rendered = tool.output.render(exec.arguments, value)
...
meta = tool.output.presentationMeta(...)   // optional
```

So:

* **Structured data** → return an object/array matching `output.schema`; give `render` a text summary
  (or a `[{type:'image',...}]` block when you want the model to see an image).
* **Text** → `schema: { type: 'string' }` + `render: (_a, v) => [{ type: 'text', text: v }]`.
* **Errors**: throwing from `execute` turns the call into a normal failed tool result, not a turn
  failure; the model sees exactly `Error: <message>` (`RT/dsh-tools/README.md:215`).
* Values must be lossless JSON — no `Date`, `Map`, class instances, or `undefined` (`snapshotToolValue`,
  cited above). Serialize timestamps as ISO strings / epoch numbers.
* Cancellation is cooperative: `exec.signal` is caller-owned; call `exec.signal.throwIfAborted()` first
  and forward the signal to I/O (`RT/dsh-tools/README.md:60`; identical pattern in
  `SIDEBAR/src/agent-opens.ts:248-249`).

### 2.4 A real 0.2.x registration (third-party, mounted live)

```ts
// SIDEBAR/src/agent-opens.ts:24-27 (imports)
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

// SIDEBAR/src/agent-opens.ts:204-263 (condensed, real code)
return ctx.tools.register(defineTool({
  name: 'sidebar_open',
  description: 'Open a local file, a local folder, or an HTTP(S) page in the sidebar of the calling conversation. ...',
  parameters: {
    target: { type: 'string', required: true, description: 'Absolute or session-cwd-relative local path, or an http:// / https:// URL.' },
    title:  { type: 'string', description: 'Optional tab title ...' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind:      { type: 'string',  required: true, description: 'What was opened: file | folder | url.' },
        target:    { type: 'string',  required: true, description: 'The absolute path or URL ...' },
        title:     { type: 'string',  required: true, description: 'The tab title used ...' },
        delivered: { type: 'boolean', required: true, description: 'Whether the open was pushed ...' },
      },
    },
    render: textRender((v: { kind: AgentOpenKind; target: string; title: string; delivered: boolean }) =>
      v.delivered ? `Opened ${v.kind} "${v.title}" (${v.target}) in the sidebar.`
                  : `Requested opening ${v.kind} ... queued ...`),
  },
  execute: async (args: { target: string; title?: string }, exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const sessionId = sessionIdOf(exec)               // exec.agent is the calling agent
    ...
    return { kind, target, title, delivered }         // canonical value only
  },
}))
```

with the render helper

```ts
// SIDEBAR/src/agent-opens.ts:130-132
function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}
```

Two conventions worth copying: the description states preconditions the model must relay ("The side
card setting ... must be on"), and the canonical value carries **no UI/transport vocabulary**
(`SIDEBAR/src/agent-opens.ts:10-20` "Conventions (per plugin-development-guide.md §3)"; C4, C10).

`exec` (type `ToolRunContext`) carries at least `callId`, `rootCallId`, `name`, `arguments`, `agent?`,
`parent?`, `signal` — the 0.2.1 dispatch reads `exec.callId`/`exec.rootCallId`/`exec.signal`
(`RT/dsh-tools/lib/index.js:3230-3235`) and tools read `exec.agent.session.id`
(`SIDEBAR/src/agent-opens.ts:250`, agent face mirror at
`SIDEBAR/src/context-types.ts:714-730`). It is *not* a `.d.ts`-verified signature — see §0.

### 2.5 How it reaches the model

* Native mode: the model sees `{name, description, parameters}` only; `output`, `execute`,
  `timeoutMs`, presenters and `deferLoading` never leak (`RT/dsh-tools/lib/index.js:3136-3145`
  `schemaOf()`, `:3120-3122` `schemas()`). Descriptions are what the model "reads" — write them for a
  model, not for a UI.
* Tool results are persisted as the `render` content plus optional `presentationMeta`
  (`RT/dsh-tools/README.md:37`); the durable log holds rendered content, so a panel cannot rebuild
  canonical values from session history — read storage instead.
* Registration order / set changes are prefix-stable only while unchanged (`RT/dsh-tools/README.md:176`).

## 3. HTTP routes on the web host (for the React panel)

Service: `ctx.webServer`, from `@deepseek-ai/dsh-host-webserver` 0.2.1-rc.3. It is a plain `node:http`
(optionally `node:https`) route registry that "knows no harness concepts" — the `/api` bridge, plugin
bundles, HMR stream and SPA dist belong to the plugins that register them
(`RT/dsh-host-webserver/README.md:12`).

### 3.1 API

```js
// RT/dsh-host-webserver/lib/index.js:327-345 (implementation, JSDoc retained)
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @returns the disposer removing the route.
 */
register(route) { /* route: { kind: 'exact'|'prefix', path, handler(req,res) } */ }

registerUpgrade(route) { /* exact-path HTTP upgrade (WebSocket) */ }
```

Matching: `exact` table first, then longest `prefix`, then the single fallback handler
(`RT/dsh-host-webserver/README.md:61`). `path` is an absolute pathname with **no trailing slash**.
Handlers own the full response lifecycle (they may hold the socket open, e.g. SSE)
(`RT/dsh-host-webserver/README.md:61`, `lib/index.js:327-360`). A duplicate `(kind,path)` throws at
registration — two plugins cannot claim `/portfolio/api`.

Composition facts that matter: `ctx.webServer.port`, `.protocol` (`'http:'`/`'https:'`),
`.getOrigin()` (`lib/index.js:305-320`).

### 3.2 Real registration pattern (JSON API over a prefix route)

```ts
// SIDEBAR/src/index.ts:895-926 (condensed)
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/sidebar/api',
  handler: async (req, res) => {
    if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return }
    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
    ...
    writeOk(res, await handler(payload))
  },
}), 'dsh-better-sidebar: /sidebar/api routes')
```

Response envelope + helpers: `SIDEBAR/src/wire.ts:73-102` (`writeJson`, `writeOk`, `writeError`,
bounded `readJsonBody` with a 1 MiB cap at `:41`). Copy this envelope — the client half already
consumes `{ok:true,value}` / `{ok:false,error:{code,message}}`.

### 3.3 Auth: there is no per-route auth; there IS a trust fence

* **Anyone** who can reach the port can reach a registered route. The webserver ships "no server-wide
  TLS, authentication, or origin policy" (`RT/dsh-host-webserver/README.md:130`).
* The shipped GUI's own surface is authenticated with a signed per-authority cookie by
  `dsh-client-connection`; `authenticate()` decodes the cookie and
  `writeUnauthorized()` emits exactly `dsh web authentication required; reopen the URL printed by dsh web.`
  (`RT/dsh-client-connection/lib/index.js:555-576`). That gate belongs to that plugin's `/api`
  FetchHandler, **not** to routes you register.
* A plugin route should copy the DNS-rebinding/cross-site fence the `/api` gateway uses — Host header
  must be loopback or a configured trusted authority, `sec-fetch-site: cross-site` refused, `Origin`
  (when present) same hostname. `SIDEBAR/src/trust-fence.ts:1-8,78-101` implements it and states
  plainly: "This is a DNS-rebinding / cross-site defense, not authentication." It feeds it the live
  trust list: `isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)`
  (`SIDEBAR/src/index.ts:767`; `webRuntime` is created with `trustedHosts: options.trustedHost ?? []`
  in `RT/dsh-web-app/lib/startup.js:67`).

### 3.4 How the panel calls it

The React panel runs inside the GUI page, so a **relative** URL is same-origin and carries the page's
cookie automatically:

```ts
// SIDEBAR/src/client/api.ts:144
response = await fetch(`/sidebar/api/${method}`, { method: 'POST', headers: {...}, body: JSON.stringify(payload), signal })
```

That is the pattern to use for `/portfolio/api/<method>`. Do not hardcode `127.0.0.1:57267`; the port
is assigned per launch (`ctx.webServer.port`).

### 3.5 Typed RPC alternative (heavier, first-party)

`@deepseek-ai/dsh-api-gateway` provides `ctx.typertGateway` and the client's `ctx.remote` over the
`/api` bridge with generated `InvocationDescriptor`s, `@Remote`/`@RemoteScope` decorators,
argument validation, cancellation and streams (`RT/dsh-api-gateway/README.md:12`,
`RT/dsh-typert-protocol/README.md:12`). It requires a Typert codegen pipeline
(`ctx.typert.local` strict descriptors) and `dsh-api-remote-access` policy. **Recommendation:** not for
a third-party plugin; use a `/portfolio/api` prefix route (§3.2) — that is what the one real
third-party plugin in this install does.

**Verified limitation (important):** on the live GUI listener I probed, the `dsh-better-sidebar`
routes are *not* answering — see §7 item 3. A custom route must be reachability-tested in the target
app before the panel work depends on it.

## 4. Persistence and config

### 4.1 What is actually mounted in the desktop runtime

The desktop profile composes `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + local bundles
(`/Users/lanlan/.dsh/profiles/desktop/package.json`, `dsh.profile.bundles`). `dsh-base`'s patch mounts
a full durable-KV stack:

```yaml
# RT/dsh-base/cordis.patch.yml:176-190
    # Durable KV storage: the storage hub, the json backend, and the
    # schema-validated domain form over them. ...
    - id: storage
      name: '@deepseek-ai/dsh-storage'

    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

It is live on this machine: `/Users/lanlan/.dsh/storages/` contains `workspace.json`,
`session_projcache.json` and `session_projcache/` (created by first-party consumers of the same
stack). Format: one human-readable `<unit>.json` per domain (`single` layout) or a `<unit>/<table>/<key>.json`
tree (`per-record`), atomically published (`RT/dsh-storage-json/README.md:10-24,42-56`).

### 4.2 Recommended: a storage domain for holdings

`ctx.storageDomain` (`DomainFacility`) gives schema-validated records, synchronous reads from memory,
durable writes, and `domain/changed` events. Declare the domain once, export it, open it in `apply`.

```ts
// Spec vocabulary: RT/dsh-storage-domain/README.md:36-52 ; implementation lib/index.js:45-92
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id)   // synchronous, from memory
```

* Record schemas are **zod** (`zod 4.4.3` per `RT/dsh-storage-domain/package.json`); plugin `Config`
  stays schemastery (`README.md:87`).
* `defineDomain` validates at module load: name/table names must match `UNIT_NAME_RE`, `version` a
  non-negative integer, `compatibleVersions` below `version`, `layout` `'single' | 'per-record'`, and a
  `global` schema must not accept `null` (`RT/dsh-storage-domain/lib/index.js:62-80`). Use
  `layout: 'per-record'` when each holding is its own document (point writes never rewrite the rest);
  the default `single` keeps one pretty-printed JSON file.
* Table handle API (real, compiled): `get(key)` `:241`, `entries()` `:245`, `keys()`, `size`,
  `put(key, value) => Promise` `:257`, `delete(key) => Promise<boolean>` `:264`,
  `update(key, fn) => Promise` `:281`. Reads throw after close (`assertReadable`).
* Writes are durable-first, then memory, then one `domain/changed` event in write order; a throwing
  listener is contained (`README.md:73,88`; `lib/index.js:196-246`). Lifecycle: the caller owns the
  handle and closes it (`README.md:63-65`).
* Only one open handle per domain name — `already-open` otherwise (`README.md:73`), so open once in
  `apply` and share the promise.

Why not the alternatives:

* `ctx.settings` (`RT/dsh-settings/README.md:8-12,39`) edits **configuration** — volatile fields of
  profile entry rows — and its own docs frame it as "live plugin configuration through Config-derived
  forms". It is the right place for *preferences* (currency, default risk target), **not** for the
  holdings ledger. `better-sidebar` uses it for prefs only (`SIDEBAR/src/index.ts:786-900`), and
  `SettingsConflictError` exists for stale writes (`SIDEBAR/src/index.ts:47`).
* Raw files under the workspace / `$DSH_HOME`: possible (`ctx.fs`, `ctx.profileContext?.home` —
  `SIDEBAR/src/index.ts:742-745` uses `ctx.profileContext?.home`), but you would re-implement atomic
  writes, schema validation and change notification. Use storage-domain.

### 4.3 Config vs data split for portfolio-manager

* **Config** (schemastery `Config`): base currency, target allocation percentages, risk-free rate,
  max single-name weight, panel defaults. Volatile fields for anything the panel edits live.
* **Data** (storage domain `portfolio/holdings`, `version: 1`, `per-record`): one record per symbol
  (`symbol`, `name?`, `assetClass`, `shares`, `marketValue`, `costBasis`, `updatedAt` ISO string).
  Add a second table `transactions` later without bumping `version` only if the new table keeps
  `version` semantics honest — backends reject a *stored* version differing from the descriptor
  (`RT/dsh-storage/lib/types/backend.d.ts` equivalent: `version-mismatch`, quoted in
  `RT/dsh-storage-json/README.md:54-56`).

## 5. How the plugin package declares and mounts itself

### 5.1 `package.json` fields

Real third-party example (`SIDEBAR/package.json`):

```json
// SIDEBAR/package.json:13-17
"main": "lib/index.js",
"types": "lib/types/index.d.ts",
"exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, ... }

// SIDEBAR/package.json:43-57
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-locale", ...], "platform": "web" },
  "manifestVersion": 1
}
```

Documented contract (`RT/dsh-package-manifest/README.md:29-53`):

```ts
const manifest: DshPackageManifest = {
  name: 'example-dsh-plugin',
  version: '1.0.0',
  engines: { node: '>=24', dsh: '0.1.5-alpha.1' },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },   // one path or an ordered list, relative to package root
    client,                                      // optional browser half (task-2)
  },
}
```

`dsh.manifestVersion` is the manifest format id, independent of npm/session versions;
`engines.dsh` is the declared compatible DSH range. **Neither is enforced by current installers or
loaders** (`RT/dsh-package-manifest/README.md:93`) — declare them anyway (the plugin manager's
peer-compatibility check exists but "the existing peer-compatibility check still applies, without an
additional Official-only version admission rule", `RT/dsh-plugin-manager/README.md:52`).

Also declare `@deepseek-ai/*` as **peerDependencies** (`^0.2.0-rc.1` style) and list them in
`devDependencies` at the exact matching version for types — exactly what `SIDEBAR/package.json:79`
(peerDependencies) and `:139` (devDependencies) do. `@deepseek-ai/cordis`, `dsh-tools`,
`dsh-host-webserver`, `dsh-storage-domain`, `dsh-settings`, `dsh-llm`, `react`/`react-dom` are the
peers a host+panel plugin needs.

Runtime resolution: the host builds a package table spanning the installation scope plus profile
packages, so a profile-installed plugin's value imports of `@deepseek-ai/dsh-tools` resolve to the
app's own copy even though `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` contains only
`cosmokit` and `schemastery` (`RT/dsh-app-boot/lib/index.js:766-796`
`createRuntimeResolution` / `collectInstallationScopePackages`; corroborated by
`SIDEBAR/src/agent-opens.ts:27` doing a value import of `defineTool` while that directory is absent).

### 5.2 `cordis.patch.yml` — the bundle layer

The loader composes the tree from: each `dsh.profile.bundles` entry's patch (in order), then the
profile's own `cordis.patch.yml`, then `--patch` overlays. A patch **replaces the targeted row's whole
`config` rather than merging**, rows are addressed by `id` with last-write-wins
(`RT/dsh-base/cordis.patch.yml:1-8`).

A plugin's own patch is a single insert of its row:

```yaml
# SIDEBAR/cordis.patch.yml:39-42
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
```

`SIDEBAR/cordis.patch.yml:1-30` documents the install path: `dsh plugin --profile <name> add
dsh-better-sidebar@<version>` reconciles `dsh.profile.bundles` against installed packages and appends
the bundle, whose patch then mounts the row. The same file shows `id`-targeted `disabled` with a
`!!js` expression evaluated at load time — a guard for double-mounts, evaluated only over rows before
it in entry-list order (`SIDEBAR/cordis.patch.yml:30-42`).

The live profile confirms the layers: `dsh.profile.bundles` =
`[dsh-base, dsh-web-app, dsh-experimental-agent-team-profile, dsh-experimental-auto-review,
dsh-better-sidebar]`, `patchReload: "live"`, deps `dsh-better-sidebar ^0.24.1`
(`/Users/lanlan/.dsh/profiles/desktop/package.json`), and the user layer adds id-targeted config
overrides for `ui-settings-general`, `permission`, `agent-default-model`, etc.
(`/Users/lanlan/.dsh/profiles/desktop/cordis.patch.yml:1-60`).

### 5.3 Installing a plugin into the live desktop profile

The plugin manager is the supported surface: list/enable bundles, install/remove external bundles
(`RT/dsh-plugin-manager/README.md:8-16`). For a **local** package it advertises development installs:
"Source Web and development Desktop offer `link:<absolute workspace package directory>` from the
running CLI installation"; linked packages use the checkout's deps/peers, and "rebuilding and
restarting remain necessary after code changes" (`RT/dsh-plugin-manager/README.md:50`). Run that
through `dsh plugin --profile desktop add link:/abs/path` (CLI forwarding; the profile is
Electron-owned, so the CLI-level rejection of that profile — verified separately in
`research/dev-loop.md` — must be checked before relying on it). **Do not hand-edit
`~/.dsh/profiles/desktop/cordis.patch.yml` while the app is running** unless the dev-loop task
confirms `patchReload: live` behaviour for the row.

## 6. Minimal working host plugin skeleton

One file, `src/index.ts` of the plugin package. Registers exactly one agent tool
(`portfolio_record_holding`) and one HTTP prefix route (`POST /portfolio/api/list`), persists through
one storage domain, and exposes a schemastery `Config`. Type-only imports assume the matching
`@deepseek-ai/*` devDependencies are installed; `package.json` must carry the §5.1 fields plus
`"main": "lib/index.js"`.

```ts
/**
 * dsh-plugin-portfolio-manager — host half.
 *
 * Registers:
 *   - agent tool  `portfolio_record_holding`
 *   - HTTP route  `POST /portfolio/api/<method>` on the GUI's own listener
 * Stores holdings in the `portfolio` storage domain (JSON backend, $DSH_HOME/storages).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Plugin name; the loader row references this package by name. */
export const name = 'dsh-plugin-portfolio-manager'

/** Services required before apply() runs (all mounted by the desktop base bundle). */
export const inject = ['webServer', 'tools', 'storageDomain']

// ─────────────────────────── config ───────────────────────────

export interface Config {
  /** Display currency of the portfolio. Volatile so the panel edits it live. */
  currency?: string
  /** Cap on holdings accepted by the tool (0 = unlimited). Every field optional. */
  maxHoldings?: number
}

export const Config: z<Config> = z.object({
  currency: z.string().default('CNY').volatile(),
  maxHoldings: z.number().step(1).min(0).default(500),
}) as z<Config>

// ───────────────────────── persistence ────────────────────────

/** One holding row. zod is the record schema language of storage domains. */
const holdingSchema = zod.object({
  symbol: zod.string().min(1),
  name: zod.string().optional(),
  /** Coarse bucket used by allocation/risk math. */
  assetClass: zod.enum(['cash', 'bond', 'equity', 'commodity', 'other']),
  /** Current market value in the configured display currency. */
  marketValue: zod.number().nonnegative(),
  /** Total cost in the same currency. */
  costBasis: zod.number().nonnegative(),
  /** ISO-8601; records must be lossless JSON (no Date objects). */
  updatedAt: zod.string(),
})

/** The domain is declared once and exported so other host packages can open it. */
export const portfolioSpec = defineDomain({
  name: 'portfolio',
  version: 1,
  // per-record: one file per holding, so single-holding writes stay cheap.
  layout: 'per-record',
  tables: { holdings: domainTable(holdingSchema) },
})

// ────────────────────── tiny HTTP helpers ─────────────────────

const MAX_BODY_BYTES = 1 << 20

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text) as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * DNS-rebinding / cross-site fence, not authentication: Host must be loopback,
 * `Sec-Fetch-Site: cross-site` is refused, and a present Origin must name the
 * same hostname. Mirrors @deepseek-ai/dsh-client-connection's /api fence.
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  const rawHost = req.headers.host
  if (typeof rawHost !== 'string') return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${rawHost}`) } catch { return false }
  const host = hostUrl.hostname
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
}

// ─────────────────────────── plugin ───────────────────────────

export function apply(ctx: Context, config: Config): void {
  const currency = config.currency ?? 'CNY'
  const maxHoldings = config.maxHoldings ?? 500

  // Open the domain once, share the promise, close it with the fiber.
  const opening = ctx.storageDomain.open(portfolioSpec)
  ctx.effect(() => () => { void opening.then((domain) => domain.close()) }, 'portfolio: close storage domain')
  const domain = () => opening

  // ── 1) agent-callable tool ──────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'portfolio_record_holding',
    description:
      'Create or update one holding in the user\'s investment portfolio. Use the market value and total '
      + 'cost basis in the portfolio currency (' + currency + '); quote them as plain numbers, not strings. '
      + 'Recording the same symbol again overwrites the previous value. This mutates user data, so call it '
      + 'only when the user asked to record or change a position.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Ticker or fund code, e.g. "VOO" or "000001".' },
      assetClass: {
        type: 'string',
        required: true,
        enum: ['cash', 'bond', 'equity', 'commodity', 'other'] as const,
        description: 'Coarse asset bucket used for allocation and risk math.',
      },
      marketValue: { type: 'number', required: true, description: 'Current market value in the portfolio currency.' },
      costBasis: { type: 'number', description: 'Total cost paid; defaults to marketValue when omitted.' },
      name: { type: 'string', description: 'Human-readable instrument name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          assetClass: { type: 'string', required: true },
          marketValue: { type: 'number', required: true },
          holdingCount: { type: 'integer', required: true, description: 'Total holdings after the write.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded ${value.symbol} as ${value.assetClass} at ${String(value.marketValue)} ${currency}`
          + ` (${String(value.holdingCount)} holdings total).`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const open = await domain()
      const table = open.table('holdings')
      if (maxHoldings > 0 && !table.get(args.symbol) && table.size >= maxHoldings) {
        throw new Error(`holding limit reached (${maxHoldings}); raise the plugin's maxHoldings setting first`)
      }
      const record = {
        symbol: args.symbol,
        ...(args.name === undefined ? {} : { name: args.name }),
        assetClass: args.assetClass,
        marketValue: args.marketValue,
        costBasis: args.costBasis ?? args.marketValue,
        updatedAt: new Date().toISOString(),
      }
      await table.put(args.symbol, record)          // durable before it resolves
      return {
        symbol: record.symbol,
        assetClass: record.assetClass,
        marketValue: record.marketValue,
        holdingCount: table.size,
      }
    },
  }))

  // ── 2) HTTP route for the React panel ───────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/portfolio/api',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/portfolio/api/')
        ? pathname.slice('/portfolio/api/'.length)
        : ''
      try {
        const payload = await readJsonBody(req)
        if (method === 'list') {
          const open = await domain()
          const holdings = [...open.table('holdings').entries()].map(([key, value]) => ({ key, value }))
          const total = holdings.reduce((sum, row) => sum + row.value.marketValue, 0)
          writeJson(res, 200, {
            ok: true,
            value: {
              currency,
              totalMarketValue: total,
              allocation: holdings.reduce<Record<string, number>>((acc, row) => {
                acc[row.value.assetClass] = (acc[row.value.assetClass] ?? 0) + row.value.marketValue
                return acc
              }, {}),
              holdings,
            },
          })
          return
        }
        if (method === 'delete') {
          const symbol = payload['symbol']
          if (typeof symbol !== 'string' || symbol === '') {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'symbol is required' } })
            return
          }
          const open = await domain()
          const deleted = await open.table('holdings').delete(symbol)
          writeJson(res, 200, { ok: true, value: { deleted } })
          return
        }
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
      }
    },
  }), 'portfolio: /portfolio/api routes')
}
```

Panel side (same-origin, relative URL — the page already authenticates the listener):

```ts
const res = await fetch('/portfolio/api/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
const envelope = await res.json() as
  | { ok: true; value: { currency: string; totalMarketValue: number; holdings: unknown[] } }
  | { ok: false; error: { code: string; message: string } }
```

## 7. Verification status / open items

1. **Verified by reading 0.2.1-rc.3 sources:** plugin shape, `inject`, `Config` (schemastery 3.18.5),
   `defineTool` option table + registration validation, canonical-value validation/render pipeline,
   error/cancellation semantics, `ctx.tools` visibility rules and per-agent scoping, `webServer.register`
   semantics (exact/prefix/fallback, duplicate throws, disposer), absence of route auth, the cookie
   auth of the `/api` surface, the trust-fence definition, storage stack mount + JSON root, domain
   spec/table API, settings-namespace purpose, manifest fields, patch layer semantics, local `link:`
   install path, and runtime package resolution.
2. **Not verifiable from this install:** exact TS declaration text (no `.d.ts` in `app.asar`, §0);
   whether `dsh-tools` enforces `timeoutMs` (declarative only, `RT/dsh-tools/README.md:235`);
   provider support for `deferLoading` beyond schema projection (`RT/dsh-tools/README.md:240`).
3. **Unresolved, needs the dev-loop investigation:** the live GUI listener at
   `http://127.0.0.1:57267` did **not** serve better-sidebar's routes when probed read-only:
   `GET /sidebar/api` → 404, `GET /sidebar/file` → 404, `GET /sidebar/html` → 404, while
   `GET /` → 401 `dsh web authentication required; reopen the URL printed by dsh web.` and any
   `POST` on a non-`/api` path → 405. The Electron process does run the desktop profile
   (`ps` shows `... dsh-desktop-host/lib/index.js ... /Users/lanlan/.dsh/profiles/desktop`) and its
   renderer uses the custom `dsh-app` scheme plus `--user-data-dir=~/Library/Application Support/@deepseek-ai/dsh-desktop`;
   the `dsh-host-webserver` README notes Electron loads dist over `file://` and carries fetch over an
   IPC bridge (`RT/dsh-host-webserver/README.md:12`). So either plugin HTTP routes on that listener
   are shadowed by the auth/SPA handler, or the listener is not the surface the Electron panel uses.
   **Consequence for the product:** the `/portfolio/api` route is the right host-side design, but its
   reachability from the panel must be proven before building UI on it; if the Electron renderer
   speaks IPC instead of HTTP, the panel needs the first-party client-connection path (task-2) rather
   than a bare `fetch`. Do not assume — test with the plugin actually mounted.
4. Scratch artifacts used: `/tmp/host-api-asar/dump-asar.mjs` (asar reader), `/tmp/host-api-asar/extracted`
   (my own extraction), `/tmp/dsh-asar` (teammate's extraction). Nothing outside `/Users/lanlan/freedom/research/`
   and `/tmp` was modified.
