# zot continuous on Vercel

Run your own [zot](https://zot.sh) agent in the cloud and chat with it from [web.zot.sh](https://web.zot.sh).

The agent runs in a Vercel Sandbox. Your conversations are stored in PostgreSQL (for example [Neon](https://neon.tech)), so they survive when the sandbox is replaced.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/patriceckhart/zot-continuous-vercel&env=CONTROL_API_TOKEN,ZOT_HOST_TOKEN,ZOT_CONTINUOUS_POSTGRES_DSN,ZOT_WEB_ORIGIN,ZOT_MODEL)

## What you need

- A Vercel account with Sandbox access
- A PostgreSQL database, for example a free Neon project
- An Anthropic or OpenAI API key, or an existing Claude or ChatGPT subscription login

## Setup

### 1. Deploy

Click **Deploy with Vercel** above, or import this repository in Vercel with the framework preset **Other**.

### 2. Add environment variables

In Vercel, open **Settings > Environment Variables** and add these for **Production**:

| Variable | Value |
| --- | --- |
| `CONTROL_API_TOKEN` | A random secret, at least 32 characters. Used to start and stop the agent. |
| `ZOT_HOST_TOKEN` | A different random secret, at least 32 characters. Used to log in from web.zot.sh. |
| `ZOT_CONTINUOUS_POSTGRES_DSN` | Your database URL, ending with `?sslmode=verify-full` or `?sslmode=require` |
| `ZOT_POSTGRES_TRUST_REMOTE_DURABILITY` | `true` when using Neon |
| `ZOT_WEB_ORIGIN` | `https://web.zot.sh` |
| `ZOT_PROVIDER` | `anthropic`, `openai`, or `openai-codex` |
| `ZOT_MODEL` | For example `claude-sonnet-4-6` |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Your API key for the selected provider |

Generate a secret in the terminal:

```sh
openssl rand -hex 32
```

Redeploy after changing variables.

### 3. Start the agent

```sh
curl -X POST https://YOUR-PROJECT.vercel.app/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN"
```

Starting takes up to a minute. The response contains a `websocketUrl`.

### 4. Connect

Open [web.zot.sh](https://web.zot.sh), enter the `websocketUrl` and your `ZOT_HOST_TOKEN`. Done.

## Everyday use

**Check status**

```sh
curl https://YOUR-PROJECT.vercel.app/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN"
```

**Stop the agent**

```sh
curl -X DELETE https://YOUR-PROJECT.vercel.app/api \
  -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"discardWorkspace":true}'
```

Your conversations stay in the database. Files in the sandbox are deleted. Start again with step 3.

The sandbox also stops automatically after 30 minutes by default. Change this with `ZOT_SANDBOX_TIMEOUT_SECONDS`.

## Optional settings

### Use a Claude or ChatGPT subscription instead of an API key

Leave the API key empty and set one of these:

```dotenv
# Claude subscription
ZOT_PROVIDER=anthropic
CLAUDE_OAUTH_JSON={"access_token":"...","refresh_token":"...","expiry":"2026-12-01T00:00:00Z"}

# ChatGPT / Codex subscription
ZOT_PROVIDER=openai-codex
CODEX_OAUTH_JSON={"access_token":"...","refresh_token":"...","expiry":"2026-12-01T00:00:00Z","account_id":"..."}
```

The value is the `oauth` object from your local zot `auth.json` for that provider, not the whole file.

**Note:** zot renews these tokens while running, but renewed tokens are lost when the sandbox stops. If the next start fails to log in, log in again locally and update the variable.

### Work on a GitHub repository

```dotenv
GIT_REPOSITORY=owner/repository
GIT_BRANCH=main
GITHUB_TOKEN=<token with access to that repository>
```

The branch is cloned when the agent starts. By default the agent can only read files (`ZOT_TOOLS=read,glob`). To let it edit code and run commands:

```dotenv
ZOT_TOOLS=read,glob,write,edit,bash
GIT_ALLOW_PUSH=true
```

**Push your work before stopping.** Unpushed changes are lost with the sandbox.

### All other variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZOT_STORE_NAME` | `main` | Name of the conversation store in the database |
| `ZOT_SANDBOX_NAME` | `zot-continuous` | Name of the sandbox in Vercel |
| `ZOT_SANDBOX_TIMEOUT_SECONDS` | `1800` | Runtime before automatic stop, 60 to 18000, subject to your Vercel plan |
| `ZOT_VERSION` / `ZOT_ARCHIVE_SHA256` | pinned in `src/config.ts` | Use another zot release. Set both together. |
| `ALLOW_PREVIEW_CONTROL` | `false` | Allow preview deployments to control the sandbox |

See `.env.example` for a complete template.

## Good to know

- **One agent per deployment.** Do not point two deployments at the same database store.
- **Keep both tokens secret.** `CONTROL_API_TOKEN` controls the sandbox, `ZOT_HOST_TOKEN` gives full access to the agent. If one leaks, replace it in Vercel and redeploy.
- **The agent can see its own secrets.** With `bash` enabled it can read the API key, database URL and GitHub token inside the sandbox. Only use repositories and prompts you trust.
- **Not always on.** The sandbox stops after its timeout. Queued work continues the next time you start it.
- **Database connection lost?** The agent stops. Start it again.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Redirecting...` | Check the URL. It must end in `/api`, not `//api`. |
| `401` | Wrong `CONTROL_API_TOKEN`, or the variable was added without redeploying. |
| `400` with a variable name | That variable is missing or invalid. |
| `409` | The sandbox is stopped or unhealthy. Stop it with `DELETE`, then start again. |
| web.zot.sh does not connect | Check `ZOT_HOST_TOKEN` and that `ZOT_WEB_ORIGIN` is exactly `https://web.zot.sh`. |

## Development

```sh
bun install
bun run check
bun run test
```

Tests run locally only. They do not create sandboxes or call any paid service.

## Links

- [zot](https://zot.sh)
- [zot continuous documentation](https://github.com/patriceckhart/zot/blob/main/docs/continuous.md)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)

## License

MIT
