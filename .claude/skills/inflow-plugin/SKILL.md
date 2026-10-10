---
name: inflow-plugin-node
description: Build an Inflowenger Plugin node with the Node.js/TypeScript SDK (@inflowenger/node-plugin-sdk). Use when the user asks to create, scaffold, or extend an inflow/Inflowenger plugin in Node/TypeScript — adding an action, parsing request input, reporting progress, reading/writing flow context, building the action's UI form, wiring settings, or reacting to a stopped/timed-out process. Not for extrinsic nodes (those belong to inflow-fusion), and not for the Go SDK (use inflow-plugin for that).
---

# Building an Inflowenger Plugin node (Node/TypeScript)

Instructions for writing a plugin with `@inflowenger/node-plugin-sdk`, the Node port
of the Go SDK. A plugin is a long-running Node process that appears as a node on the
Inflowenger workflow canvas and is called by the Fractal runtime over NATS.

Fuller reference lives in the SDK's GitHub repo (this skill is meant to be copied into
a consuming plugin project, so links point there rather than at local paths): the
human cookbook at
[`cookbook.md`](https://github.com/Inflowenger/node-plugin-sdk/blob/main/cookbook.md)
and concept docs under
[`docs/`](https://github.com/Inflowenger/node-plugin-sdk/tree/main/docs).
Verify the current API against the installed `@inflowenger/node-plugin-sdk` package
before relying on any signature; do not invent methods.

## When to use

Use this when building or modifying an inflow **plugin** node in **Node/TypeScript**:
scaffolding a plugin, adding/editing an action, decoding request bodies, progress
reporting, flow-context read/write, routing outbound branches, calling downstream
services, meta functions, or action/settings forms.

Do **not** use this for **extrinsic** nodes (internal service calls via inflow-fusion,
a different repo), nor for the Go SDK.

## The non-negotiable rules (get these right)

1. **The entry point must stay alive after `start()`.** `p.start()` only wires NATS
   subscriptions and returns. End `main` with `await new Promise(() => {})` or the
   process exits and the plugin dies.
2. **Every handler ends in exactly one `await job.done(...)` or
   `await job.doneWithError(...)` on every path.** On each error branch call
   `await job.doneWithError(String(e))` **and `return`**. Never finish twice or zero
   times.
3. **`await` every Job call.** `progress`, `done`, `doneWithError`, and all `cmd*`
   methods are async and return a `Promise`. Forgetting `await` drops the command.
4. **Decode input with `castRequestTo<T>(job.req.data)`.** It unwraps the
   `{ _registry, body }` envelope → `req.body` (type `T`) + `req._registry`. Unlike
   Go, it **throws** on invalid JSON — wrap it in `try/catch` and call
   `doneWithError` on failure. JSON numbers are `number` already; timestamps are
   seconds (`new Date(Number(v) * 1000)`).
5. **Keep each action's `jsonschema` in sync with its input type.** The form defines
   the shape delivered as `body`. `jsonschema`/`jsonui` are **JSON strings**
   (`JSON.stringify({...})`).
6. **Provisioning is a prerequisite, not code.** The plugin must be defined in a
   space (a NATS account in Infra) to get `PLUGIN_ID`, `INFRA_CRED` (base64), and
   `INFRA_URL`. If missing, tell the user to provision; don't fabricate credentials.

## Procedure

1. **Confirm prerequisites**: `PLUGIN_ID`, `INFRA_CRED`, `INFRA_URL` (usually a
   `.env.inflow`), Node 18+, and Infra + a Fractal running. Install the SDK from git
   (it isn't on npm): see the README's Installation section.
2. **Scaffold `main`** (ESM):
   ```ts
   import { newPlugin, withDotEnv, castRequestTo, type Job } from "@inflowenger/node-plugin-sdk";

   async function main() {
     const p = await newPlugin(withDotEnv(".env.inflow")); // or withInfraConnection + withPluginId
     p.intro({ name: "MY.PLUGIN", author: "…", version: "v0.0.1" });
     p.addAction({ method: "do.thing", title: "…", form, requestHandler });
     p.start();
     await new Promise(() => {});
   }
   main().catch((e) => { console.error(e); process.exit(1); });
   ```
3. **Write each `requestHandler(job: Job)`** using only these verified `Job` ops
   (all async):
   - `castRequestTo<T>(job.req.data)` — typed input (rule 4).
   - `job.progress(pct, { title, content })` — advisory, 0–100; does not finish.
   - `job.done(obj, ...key)` — success + output (finishes).
   - `job.doneWithError(str)` — failure (finishes); the reason goes on the command's
     own `error` field, never into `details`.
   - `job.doneWithErrorCode(num, str, obj, ...key)` — same, plus the plugin's own
     error number (pass `0` when it has none).
   - `job.doneWithErrorData(str, obj, ...key)` — failure that keeps a payload/state
     alongside the reason (finishes).
   - `job.cmdGetCurrentScope()` / `job.cmdGetScope("$.path")` — read context; both
     resolve to a `Uint8Array` (decode with `TextDecoder`).
   - `job.cmdSetOnPath("$.path", obj)` — write into flow context.
   - `job.cmdNextFilter(tags)` — fire only the outbound branch(es) with these tags.
   - `job.cmdSvcCall(action, data, op?)` — call a downstream service mid-job.
4. **Add forms** when the node needs configuration. Either hand-write JSON Forms —
   `form: { jsonschema: JSON.stringify(schema), jsonui: JSON.stringify(ui) }` — or
   build both documents from one declaration with the `formkit` namespace:
   `import { formkit } from "@inflowenger/node-plugin-sdk"`, then
   `form: formkit.form("Title").add(formkit.text("k","K").required()).build()`.
   Plugin-level onboarding/config: `p.requiredParams({ ..., submitHandler })` (or
   `formkit.form(...).settings(handler)`). Register live meta functions with
   `p.addMeta({ method, requestHandler })` before `start()`.
5. **Only if in-flight work must stop with the process**, register a signal handler
   before `start()`:
   ```ts
   import { canceled } from "@inflowenger/node-plugin-sdk";

   p.onSignal((sig) => {              // inflow.plugin.<PLUGIN_ID>.>
     if (canceled(sig.conclusion)) {  // flow_stop_by_user / stop_command / timeout / idle
       inflight.get(sig.jobId)?.abort(); // sig.jobId === the job.jobId you were given
     }
   });
   ```
   This is **optional and not the default**: a stopped process deliberately does not
   stop the job, because a later run of the node may build on its progress (the
   previous `jobId` comes back in `_registry`). Add it only for a stream to close, an
   upstream call to abort, a lock to release. Signals also arrive on success, so
   always filter on `sig.conclusion`; and once one lands, the runtime no longer
   answers that job's commands — do not try to `done` an abandoned job.
6. **Build & run**: `npm run build` then run the entry, or `npx tsx your-plugin.ts`.
   The SDK logs each subscribed subject on startup. Verify by adding the node to a
   flow and running it.

## Meta functions & form buttons

- **Meta functions** are live request/reply handlers the form can call while open —
  register with `p.addMeta({ method, requestHandler })` before `start()`; each is
  served on `inflow.v1.<PLUGIN_ID>.<method>`. The handler returns any JSON-able value,
  marshalled **verbatim** (a `Response`, a bare array, or a `formkit` patch/envelope).
- A form button (`formkit` `.lookup(fn, label)`, or a hand-written `x-inflow-ui`
  control) calls a meta function and patches the answer back into the open form — one
  match via `formkit.success(...).patch({...})`, several via `formkit.choose(...)`.
- **There is no error channel in the transport.** Say what happened under the
  reserved `x-inflow-notif` key, which the host lifts out of the answer and shows —
  or the button appears to do nothing:
  ```ts
  return formkit.success("Issue: %s", key).patch({ issueKey: key });
  return formkit.failure("cannot reach %s: %s", site, err).patch(null); // message only
  ```
  `formkit.info` / `success` / `warning` / `failure` / `help` are the five severities;
  `.about(field)` re-aims a message, `.patch(null)` is a valid answer on its own (a
  connection test writes nothing). The message defaults to the field the button
  targets; a field some *other* control fills needs `.inline()` on it so the host has
  somewhere to put it. Do **not** add a readonly `lookupStatus`-style property for
  this — a message is not form data, and one declared as a field is sent to the
  service and stored with the rest. The catalog's `dependent-fields.md` still
  describes the pre-`x-inflow-notif` status-field workaround; this supersedes it.
- If asked about **extrinsic** nodes, redirect to inflow-fusion; not part of this SDK.

## Verify before finishing

- `npm run build` (tsc) passes with no type errors.
- The entry point blocks after `start()`.
- Each action: unique `method`, a `requestHandler`, exactly one finish per path, all
  Job calls `await`ed.
- Each `jsonschema` matches its input type.
- No fabricated SDK methods — every `Job`/`Plugin` call exists in the installed
  `@inflowenger/node-plugin-sdk`.
