# emil

Mailbox Organization with IMAP polling and configurable processing chain (plugins).

## 1. Features

- Polling over IMAP with persisted progress (`imap-state.json`)
- Day-window based message processing with restart-safe state
- Configurable processing chain (`runtime.steps`)
- Built-in spam classification plugin
- Built-in OpenAI classification plugin
- Custom plugin loading (built-in, local path, package import)
- Docker-ready runtime

## 2. Requirements

- Node.js 20+ (tested with Node 22 in Docker)
- An IMAP account
- Optional for OpenAI plugin: OpenAI API key

## 3. Quick Start (Local)

1. Install dependencies:

```bash
npm ci
```

2. Configure file:

- Copy `config/config.example.json` to `config/config.json`
- Edit `config/config.json` with your credentials and folders

3. Start:

```bash
npm start
```

Environment variables:

- `CONFIG_PATH` optional, default is `./config/config.json`
- `LOG_LEVEL` optional, default is `info`

## 4. Docker

Files included:

- `Dockerfile`
- `.dockerignore`

Build image:

```bash
docker build -t emil:latest .
```

Run container:

```bash
docker run --rm -it \
  -e CONFIG_PATH=/app/config/config.json \
  -e LOG_LEVEL=info \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  emil:latest
```

If you use external plugins:

```bash
docker run --rm -it \
  -e CONFIG_PATH=/app/config/config.json \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/plugins:/app/plugins" \
  emil:latest
```

Then reference plugin paths in config, for example `"/app/plugins/my-plugin.js"`.

## 5. Configuration Reference

Top-level structure:

```json
{
  "imap": { "...": "..." },
  "runtime": { "...": "..." }
}
```

### 5.1 `imap`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `host` | string | yes | - | IMAP host |
| `port` | number | yes | - | IMAP port |
| `secure` | boolean | no | `true` | TLS |
| `user` | string | yes | - | IMAP username |
| `pass` | string | optional | - | IMAP password |
| `passEnv` | string | optional | - | Name of environment variable that contains IMAP password |
| `folder` | string | no | `INBOX` | Source folder to open and process |
| `startAt` | object | no | `{ "type": "epoch" }` | See section below |
| `filter.criteria` | array | no | `["ALL"]` | Allowed values: `ALL`, `SEEN`, `UNSEEN` |
| `options.maxFetchBytes` | number | optional | - | Limit fetched message source bytes |
| `maxAttempts` | number | no | `5` | Max retries after `nack` before skipping the mail |
| `storage.filePath` | string | no | `/data/imap-state.json` | Persisted state path |
| `idlePollingIntervalMs` | number | no | `10000` | Poll interval for no-message state |

`startAt` options:

- `{ "type": "epoch" }` -> start from 1970-01-01
- `{ "type": "minDate", "value": "YYYY-MM-DD" }` -> start from explicit UTC date
- `{ "type": "now" }` -> prime current day and only process newly arriving messages from then on

Retry behavior:

- Each `nack` increments a counter for the current message UID.
- When `maxAttempts` is reached, the mail is skipped from future processing.
- The current attempt and attempted Uid are persisted in the state file.

### 5.2 `runtime`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `plugins` | string[] | no | `[]` | Plugin modules to load |
| `errorPolicy` | `"stop" \| "continue"` | no | `"stop"` | Chain behavior on step errors |
| `steps` | array | no | `[]` | Ordered processing steps |

Each step:

```json
{
  "name": "provider-name",
  "config": {}
}
```

`steps[].name` must match a provider that was registered by loaded plugins.

## 6. Built-in Plugins

## 6.1 `builtin:classification.spam`

Load plugin:

```json
{
  "runtime": {
    "plugins": ["builtin:classification.spam"]
  }
}
```

Use as step:

```json
{
  "name": "builtin:classification.spam",
  "config": {
    "spamHeaders": [],
    "spamSubjectsPatterns": ["\\*\\*\\*SPAM\\*\\*\\*"],
    "blockedSenders": [],
    "blockedDomains": [],
    "trustedSenders": [],
    "trustedDomains": [],
    "authFailPatterns": ["spf=fail", "spf=softfail", "dkim=fail", "dmarc=fail"],
    "scoring": {
      "minScore": 80,
      "weights": {
        "subjectPattern": 25,
        "headerPattern": 30,
        "senderAddress": 45,
        "senderDomain": 35,
        "authFail": 60
      }
    },
    "spamFolder": "Spam"
  }
}
```

Behavior:

- Trusted sender/domain => always not spam
- Score >= `minScore` => move to `spamFolder` and return `ack`
- Classifier config/parse problems => warning and `continue`
- Move errors => `nack`

## 6.2 `builtin:classification.openai`

Load plugin:

```json
{
  "runtime": {
    "plugins": ["builtin:classification.openai"]
  }
}
```

Use as step:

```json
{
  "name": "builtin:classification.openai",
  "config": {
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o-mini",
    "thresholds": {
      "minConfidence": 0.75
    },
    "limits": {
      "maxTextChars": 6000,
      "maxHtmlChars": 6000
    },
    "labels": [
      {
        "id": "action_required",
        "prompt": "Requires concrete action from the user.",
        "folder": "INBOX/ai/001_Aktion"
      },
      {
        "id": "newsletter",
        "prompt": "Newsletter or advertising content.",
        "folder": "INBOX/ai/004_Newsletter"
      },
      {
        "id": "general_inbox",
        "prompt": "General important communication.",
        "folder": "INBOX"
      }
    ],
    "labelMap": {
      "general_inbox": "INBOX"
    }
  }
}
```

Options:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `apiKey` | string | optional | - | Direct API key |
| `apiKeyEnv` | string | no | `OPENAI_API_KEY` | Env var fallback |
| `model` | string | no | `gpt-4o-mini` | OpenAI model |
| `labels` | array | yes | - | Allowed classification labels |
| `labels[].id` | string | yes | - | Label id used by model output |
| `labels[].prompt` | string | yes | - | Label description used in system prompt |
| `labels[].folder` | string | optional | - | Default folder for label |
| `labelMap` | record | no | `{}` | Override folder by label id |
| `thresholds.minConfidence` | number (0..1) | no | `0.75` | Minimum confidence |
| `limits.maxTextChars` | number | no | `6000` | Text truncation limit |
| `limits.maxHtmlChars` | number | no | `6000` | HTML truncation limit |

Behavior:

- Classifies from `subject`, `from`, `text`, `html`
- Low confidence => add `\\Flagged`, return `continue`
- Unknown label => add `\\Flagged`, return `continue`
- Missing target folder => add `\\Flagged`, return `continue`
- Target folder equals source folder => skip move, return `ack`
- OpenAI/API failures => `nack`
- Move failures => `nack`

## 7. Processing Chain Semantics

Provider return values:

- `continue` or `void` -> next step
- `ack` -> current message acknowledged and stop chain
- `nack` -> current message not acknowledged and stop chain
- `stop` -> treated like `ack` and stop chain

Chain fallback:

- If all steps end in `continue`, chain performs safety `ack`.

Error policy:

- `runtime.errorPolicy = "stop"` -> step error leads to `nack`
- `runtime.errorPolicy = "continue"` -> log and continue with next step

## 8. State Persistence (`imap-state.json`)

Stored values include:

- Start mode (`startAtKey`, `startAtValue`)
- Day window (`rangeStartMs`, `rangeEndMs`)
- Processed UIDs in current window (`processedUids`)
- `criteriaMask`
- `uidValidity`
- `fromNowPrimed`

State resets automatically when:

- IMAP `uidValidity` changed
- `startAt` changed in config
- `filter.criteria` changed in config

## 9. Custom Plugins

A plugin module must export `registerProviders(registry)`.

Minimal JS plugin:

```js
// /app/plugins/example-tagger.js
export function registerProviders(registry) {
  registry.registerProvider('custom:tagger', async ({ message, imap, logger, stepConfig }) => {
    const flag = typeof stepConfig.flag === 'string' ? stepConfig.flag : '\\\\Flagged';
    await imap.addFlags(message.uid, [flag]);
    logger.info(`Tagged UID=${message.uid} with ${flag}`);
    return 'continue';
  });
}
```

Enable plugin in config:

```json
{
  "runtime": {
    "plugins": ["/app/plugins/example-tagger.js"],
    "steps": [
      {
        "name": "custom:tagger",
        "config": {
          "flag": "\\Flagged"
        }
      }
    ]
  }
}
```

Provider context object:

- `message`: current parsed mail payload
- `imap`: restricted IMAP middleware
- `stepName`: configured provider name
- `stepConfig`: step-local config object
- `logger`: logger with `debug/info/warn/error`

Allowed IMAP operations inside plugins:

- `moveMessage(uid, folder)`
- `deleteMessage(uid)`
- `addFlags(uid, flags[])`
- `removeFlags(uid, flags[])`
- `getSourceFolder()`

## 10. Security Notes

- Do not commit real credentials into `config/config.json`.
- Prefer environment variables for secrets (`apiKeyEnv`).
- IMAP password can be provided either via `imap.pass` or via `imap.passEnv` environment variable.
- Plugins execute arbitrary code. Only load trusted plugin modules.
