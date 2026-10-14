# grokdex

[![npm](https://img.shields.io/npm/v/grokdex)](https://www.npmjs.com/package/grokdex)
[![CI](https://github.com/aarock1234/grokdex/actions/workflows/ci.yaml/badge.svg)](https://github.com/aarock1234/grokdex/actions/workflows/ci.yaml)
[![License](https://img.shields.io/badge/License-Elastic_2.0-blue)](LICENSE)

grokdex lets [Grok Build](https://github.com/xai-org/grok-build) use your ChatGPT plan. Grok's agent, tools and UI
stay the same. Only the model changes.

It signs in through OpenAI's official
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) flow for open-source apps, so
usage counts against your Plus, Pro or Business plan. It also works with an OpenAI API key.

Requires Node.js 24 or newer.

## Setup

Run setup and pick how you want to connect:

```sh
pnpm dlx grokdex setup
```

`npx grokdex setup` works too.

It signs you in, lets you choose models, and adds them to `~/.grok/config.toml`. Then start Grok with one of them:

```sh
grok -m gpt-6.1-sol
```

Or switch with `/model` in any session.

## Commands

| Command                     | Description                                   |
| --------------------------- | --------------------------------------------- |
| `grokdex setup`             | Connect a provider and add its models to Grok |
| `grokdex status`            | Show what is connected                        |
| `grokdex remove`            | Remove grokdex from Grok's config             |
| `grokdex remove --sign-out` | Also sign out and delete saved credentials    |

To update, run `pnpm dlx grokdex@latest setup` again.

## How it works

Setup writes one marked block to Grok's config and leaves the rest alone:

```toml
[auth_provider.grokdex-chatgpt]   # Grok runs this for a token; grokdex refreshes it
[mcp_servers.grokdex]             # Grok runs this per session; it hosts the adapter
[model_providers.grokdex-chatgpt] # points the models at the adapter
[model."gpt-6.1-sol"]             # one table per model you picked
```

The ChatGPT plan route differs from the regular API in a few ways Grok doesn't handle yet. The adapter runs on
`127.0.0.1:18456` while Grok is open and fixes them:

- Grok sends `system` messages. The adapter sends them as `developer`.
- Grok's title and recap calls name Grok models. The adapter sends them to `gpt-6-luna`.
- The route ends each stream with an empty `output`, which Grok reads as no answer. The adapter fills it in.

The adapter never stores your credentials. Grok's token passes straight through. Credentials live in
`%LOCALAPPDATA%\grokdex` on Windows and `~/.config/grokdex` elsewhere, readable only by you.

## Configuration

| Variable             | Default      | Description                        |
| -------------------- | ------------ | ---------------------------------- |
| `GROKDEX_SIDE_MODEL` | `gpt-6-luna` | Model for Grok's titles and recaps |
| `GROKDEX_HOME`       | see above    | Where credentials are stored       |
| `GROK_HOME`          | `~/.grok`    | Grok's config directory            |

Grok's next-prompt suggestions use Grok's own model. To use GPT for those too, add
`prompt_suggestion = "gpt-6-luna"` under `[models]` in your Grok config.

## Limits

OpenAI's plan route is in preview. It has no hosted tools such as image generation or file search, and requests
fail with `subscription_sharing_usage_limit_exceeded` once your plan's limit is reached.

## Development

| Command                 | Description                          |
| ----------------------- | ------------------------------------ |
| `pnpm check`            | Typecheck, lint and check formatting |
| `pnpm build`            | Compile to `dist`                    |
| `node src/cli.ts setup` | Run setup from source                |

## License

[Elastic License 2.0](LICENSE)
