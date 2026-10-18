# zot continuous on Vercel Sandbox

A small Vercel control API that starts a [zot continuous](https://github.com/patriceckhart/zot) host inside a Vercel Sandbox. Conversations and execution records live in PostgreSQL. The sandbox, local state directory, and Git checkout are disposable. No persistent volume is required.

This is a single-host deployment template, not a multi-tenant service or an always-on scheduler. It contains no browser chat UI. Connect an existing compatible client, such as [web.zot.sh](https://web.zot.sh), to the returned WebSocket URL.

**Status:** locally tested scaffolding. A real Vercel deployment, Sandbox networking, database connection, and subscription login have not been tested by this repository's local suite.

## Architecture

```text
Administrator
  │ HTTPS + CONTROL_API_TOKEN
  ▼
Vercel Function: /api
  │ project OIDC, create / inspect / delete
  ▼
Vercel Sandbox (non-persistent)
  ├── Node supervisor
  ├── public port 3000: WebSocket bridge
  │     └── localhost:7787: zot continuous serve
  ├── PostgreSQL / Neon: durable conversation and execution records
  ├── /tmp/zot-host/state: local lock, socket, and store binding
  ├── /tmp/zot-host/home/auth.json: temporary provider credentials
  └── /tmp/zot-host/workspace: optional GitHub checkout

Browser client ── WSS + ZOT_HOST_TOKEN ──► Sandbox domain
```

The Vercel Function handles short-lived control requests. It does not host zot or proxy the long-lived WebSocket. Vercel terminates public TLS at the Sandbox domain. The bridge forwards WebSocket traffic to zot's loopback listener, preserves the browser Origin, and never authenticates on the client's behalf. zot requires its normal token-bearing `hello` protocol message.

## Prerequisites

- A Vercel project and plan with Sandbox access and sufficient execution limits.
- Node.js 24 and Bun for development. Vercel uses Node.js 24 for the control function.
- A dedicated writable PostgreSQL 15 to 18 database, reachable from the Sandbox with TLS.
- An API key or an already-authorized subscription OAuth token set supported by zot.
- Optionally, a GitHub repository and a narrowly scoped GitHub token.

The default zot binary is **0.4.35 for Linux amd64**, pinned by SHA-256. The default Vercel managed image is `vercel/sandbox/universal`, which is a rolling image. The binary is pinned, the complete environment is not.

## Local setup

```sh
bun install --frozen-lockfile
cp .env.example .env.local
bun run check
bun run test
bun run build
```

Fill in `.env.local` privately. It is ignored by Git. No secrets are included in this repository. The checks and tests do not create sandboxes, connect to PostgreSQL, refresh OAuth, or call a model.

Create two different random secrets for the control API and the zot host. Both must be at least 32 non-whitespace characters. A secret manager can generate them. If generating locally, `openssl rand -hex 32` produces a suitable value. Do not commit the output.

## Deploy later

Nothing in local setup deploys anything.

When you are ready:

1. Link this directory to a Vercel project using the Vercel CLI, or import a future Git remote.
2. Choose the "Other" framework preset. Keep the settings in `vercel.json`.
3. Add the required environment variables below as sensitive **Production** environment variables. A local `.env.local` file is not automatically uploaded.
4. Ensure project OIDC is available to the deployed function. The Sandbox SDK uses it automatically. Do not give the agent your Vercel control credentials.
5. Deploy to production. Check that your plan accepts the configured 300-second control-function limit and requested Sandbox timeout.
6. Use `POST /api` to create the sandbox. Deployment alone does not start a sandbox.

Preview control is disabled by default. Before enabling `ALLOW_PREVIEW_CONTROL=true`, use a separate database/store, sandbox name, and secrets. Production and preview deployments can otherwise address the same sandbox within one Vercel project.

For execution outside Vercel, the SDK also accepts `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, and `VERCEL_TEAM_ID`. Supply all three together. They stay in the control process and are not passed into the Sandbox. Vercel Deployment Protection, if enabled, is an additional access layer and may require its own bypass configuration for administrative HTTP calls.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `CONTROL_API_TOKEN` | Administrative bearer token for `/api`. Never give it to the browser chat client or the agent. |
| `ZOT_HOST_TOKEN` | Stable zot protocol token, installed as an admin token. Keep separate from the control token. |
| `ZOT_CONTINUOUS_POSTGRES_DSN` | PostgreSQL URL with `sslmode=verify-full` (preferred) or `sslmode=require`. |
| `ZOT_WEB_ORIGIN` | One exact HTTPS browser-client origin, for example `https://web.zot.sh`, without a trailing slash or path. |
| `ZOT_MODEL` | Model ID appropriate for the selected provider and credentials. |
| Provider credentials | One of the options in the next section. |

The host token grants full access to this zot host, including conversation administration. This template does not implement per-user isolation or multiple token roles.

### PostgreSQL and Neon

Set `ZOT_STORE_NAME` to a stable logical store name, default `main`. Reusing the database and store name opens the existing conversation collection after a sandbox is replaced. A store name is not a single conversation ID.

Use a direct or session-affine PostgreSQL connection. zot requires a dedicated session advisory lock. Transaction pooling is not supported. zot 0.4.35 rewrites recognized Neon `ep-...-pooler` hostnames to the corresponding direct hostname. That direct endpoint must be reachable.

For Neon or another managed service reporting `fsync=off`, set `ZOT_POSTGRES_TRUST_REMOTE_DURABILITY=true` only if you accept that provider's durability guarantees. This maps to zot's explicit opt-in flag. It is false by default and does not disable other database checks.

Only one writer may own a store. Do not deploy another host against the same store expecting load balancing or automatic failover. Database connection loss, including suspended Neon compute, stops the host. This template does not reconnect or take over automatically.

## Provider credentials

Credentials are injected into the detached supervisor command, not the sandbox's default environment or the command arguments. The supervisor writes only the selected provider into a mode `0600` zot `auth.json`. It does not read your laptop's credentials.

### Claude with an Anthropic API key

```dotenv
ZOT_PROVIDER=anthropic
ZOT_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=<your-api-key>
```

Leave `CLAUDE_OAUTH_JSON` unset for this mode.

### Claude subscription

```dotenv
ZOT_PROVIDER=anthropic
ZOT_MODEL=claude-sonnet-4-6
CLAUDE_OAUTH_JSON={"access_token":"<access-token>","refresh_token":"<refresh-token>","expiry":"<RFC3339-expiry>"}
```

Leave `ANTHROPIC_API_KEY` unset. The JSON must be the OAuth token object supported by zot, corresponding to `anthropic.oauth` in zot's `auth.json`. Do not paste the whole auth file or a Claude Code CLI credential file. An existing supported login is required, no browser login flow is hosted here.

### ChatGPT / Codex subscription

```dotenv
ZOT_PROVIDER=openai-codex
ZOT_MODEL=gpt-5.5
CODEX_OAUTH_JSON={"access_token":"<access-token>","refresh_token":"<refresh-token>","expiry":"<RFC3339-expiry>","account_id":"<chatgpt-account-id>"}
```

The JSON corresponds to `openai.oauth` in zot's `auth.json`. `account_id` is the ChatGPT account ID, not an API organization or project ID. A Codex CLI credential file is not the same schema. The adapter does not derive missing account IDs or convert foreign credential files.

### OpenAI API key

```dotenv
ZOT_PROVIDER=openai
ZOT_MODEL=gpt-5
OPENAI_API_KEY=<your-api-key>
```

API-key billing and subscription access are different routes. This template does not turn an API key into a subscription token or guarantee that a provider permits hosted use under your plan. Check current provider terms, account entitlements, and model availability. Only one provider is selected per host.

### OAuth renewal limitations

Both JSON variables accept `access_token`, `refresh_token`, `expiry`, `token_type`, `scope`, `client_id`, `id_token`, and `account_id`. Unknown fields are rejected. `access_token` and an RFC3339 `expiry` are required. Codex additionally requires `account_id`. Without a refresh token, access ends when the token expires.

zot can refresh supported tokens and update its local `auth.json` while the sandbox runs. **Refreshed tokens are not written back to Vercel environment variables or PostgreSQL.** They disappear with the sandbox. If the provider rotates refresh tokens, the original environment secret may no longer work on the next start. Do not share one rotating token set between your laptop and several hosts.

Before replacing a host, update your secrets from a supported fresh login or arrange secure external token persistence. This template intentionally has no credential-export API. Subscription mode is not an unattended, indefinitely renewable credential solution. API keys are simpler for unattended deployments, where appropriate.

## Optional Git workspace

```dotenv
GIT_REPOSITORY=owner/repository
GIT_BRANCH=agent/task-123
GITHUB_TOKEN=<short-lived-repository-scoped-token>
GIT_ALLOW_PUSH=false
```

The branch must already exist. Only GitHub HTTPS repositories are supported. The bootstrap clones that branch into `/tmp/zot-host/workspace`, without embedding credentials in the remote URL. Omit `GIT_REPOSITORY` to start with an empty workspace.

The Git token is used through an askpass helper during cloning. By default, it is not retained in the zot child environment. Set `GIT_ALLOW_PUSH=true` to retain it for Git operations launched by the agent. This requires a repository and token. The setting controls credential availability, not the token's permissions or the approval policy. Use server-side branch protection and a restricted token.

The default tools are `read,glob`. To let a trusted agent edit and use Git, explicitly configure the needed tools, for example `ZOT_TOOLS=read,glob,write,edit,bash`. Configure a suitable Git author identity before committing. The template never automatically commits, pushes, opens pull requests, or approves tool requests. Use the client's normal approval flow.

Only pushed changes survive workspace deletion. Uncommitted changes, unpushed commits, ignored files, caches, and local build artifacts are lost. PostgreSQL does not back up the checkout. Restarting also checks out the branch's then-current remote state, which may differ from the files associated with the stored conversation. Preserve a task branch and record the intended commit when continuity matters.

## Control API

All calls require `Authorization: Bearer <CONTROL_API_TOKEN>`. Tokens must not appear in URLs. Responses are marked `no-store`. SDK errors are not returned or logged because they may contain credentials.

Set `CONTROL_URL` to the deployed project's HTTPS URL. The examples assume the control token is already available in your shell environment. Avoid running secret-bearing commands in shared terminals or CI logs.

### Inspect without starting or resuming

```sh
curl --fail-with-body "$CONTROL_URL/api" \
  -H "Authorization: Bearer $CONTROL_API_TOKEN"
```

### Start

```sh
curl --fail-with-body -X POST "$CONTROL_URL/api" \
  -H "Authorization: Bearer $CONTROL_API_TOKEN"
```

The API downloads and verifies the pinned zot archive, optionally clones Git, starts zot, and waits for local readiness. Starting a host can recover and dispatch previously queued work in that store, it is not a read-only inspection. Use a dedicated store and do not point this at another running host's store. A successful response includes `websocketUrl` and `expiresAt`, never credentials. Connect your browser client to `websocketUrl` and authenticate using `ZOT_HOST_TOKEN` through zot's normal protocol. The returned URL is a Sandbox URL, not the control API URL. Do not put the host token in its query string.

Start is idempotent for an already-ready sandbox. It does not rotate credentials or change a running host's configuration. An existing stopped or unhealthy sandbox produces a conflict instead of silently deleting the workspace. Concurrent starts may fail on the unique sandbox name. Inspect status before retrying. The database writer lock is a final coordination guard, not a deployment scheduler.

### Stop and delete

**Push or otherwise preserve any work first. This deletes the ephemeral workspace and refreshed OAuth tokens. PostgreSQL conversations remain.**

```sh
curl --fail-with-body -X DELETE "$CONTROL_URL/api" \
  -H "Authorization: Bearer $CONTROL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"discardWorkspace":true}'
```

Deletion first tries to terminate zot through its supervisor, then deletes the sandbox. The response reports whether graceful termination succeeded. Deletion can still be abrupt. It is not a database rollback or a guarantee that external tool effects completed exactly once.

## Lifecycle and operational limits

- `ZOT_SANDBOX_NAME` defaults to `zot-continuous` and is unique within the Vercel project.
- `ZOT_SANDBOX_TIMEOUT_SECONDS` defaults to 1800. The parser accepts 60 to 18000 seconds, but your Vercel plan may impose a lower limit. No timeout extension or keepalive loop is installed.
- Sandboxes are explicitly non-persistent. No snapshot-based resume or Drive provisioning is implemented. To start again after a stopped sandbox, explicitly delete it, then start a fresh one against the same store.
- Configuration changes take effect only on a fresh sandbox. Redeploying the control function does not restart the running host.
- A failed startup attempts to delete only the sandbox it just created. A killed control function or failed cleanup can leave a sandbox behind. Inspect and remove it through the dashboard if necessary.
- Runtime host logs stay in `/tmp/zot-host/host.log` with private permissions. They are not exposed by the API and disappear on deletion. Treat them as sensitive, they can contain session or provider information.
- Default bootstrap assumes Node.js, Git, and tar in the managed universal image. Linux amd64 is checked at startup. No runtime package installation or toolchain provisioning is included.
- To upgrade zot, set both `ZOT_VERSION` (without `v`) and `ZOT_ARCHIVE_SHA256` to a verified Linux amd64 release archive. Other versions are not accepted without a checksum pin.
- The API's readiness check establishes local process/bridge availability. It does not execute a paid model request or prove that subscription credentials work.

## Security boundaries

Use this for a trusted administrator and trusted repository, not hostile multi-tenant code. The microVM separates the workload from the controller, but processes and tools inside that VM can access the host's files, credentials, environment, and network according to their privileges. Private file permissions and disabled extensions are guardrails, not isolation from code running as the same user.

The controller passes only the selected runtime configuration into the VM. It does not pass `CONTROL_API_TOKEN`, Vercel control credentials, or unused provider credentials. The selected provider credentials, database DSN, host token, and optional Git token necessarily exist in the VM. Never assume an enabled shell tool cannot read or exfiltrate them. Network egress is not restricted by this template.

The bridge enforces the configured browser Origin, but Origin is not authentication. Non-browser clients can forge it. The zot protocol token is the access check. Keep secrets out of the repository, prompts, generated files, logs, and URLs. Use a dedicated database role, narrowly scoped temporary Git credentials, and Vercel's additional project access controls where appropriate.

## Validation

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

The suite covers configuration validation, credential mapping and redaction, administrative authentication, explicit deletion confirmation, mocked Sandbox lifecycle, checksum enforcement, and real local HTTP/WebSocket upgrade forwarding under Node.js. It uses synthetic credentials and no paid or credentialed services.

Before production use, separately verify a real deployment's OIDC authorization, managed-image tools, Sandbox domain WebSocket routing, PostgreSQL TLS and writer-lock behavior, provider access, restart behavior, and Git permissions. Local tests are not evidence of cloud deployment success.

## References

- [zot continuous documentation](https://github.com/patriceckhart/zot/blob/main/docs/continuous.md)
- [Vercel Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference)
- [Sandbox images](https://vercel.com/docs/sandbox/concepts/images)
- [Sandbox persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)

## License
MIT
