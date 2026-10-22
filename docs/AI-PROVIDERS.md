# AI providers

The OpenCraft chat works with cloud models (with your own API key), local models in Ollama, and any
OpenAI-compatible endpoint. This guide covers setup, where keys are kept, what each provider receives,
and how reasoning, caching and token counts work.

## Supported providers

| Provider | You need | API used | Reasoning | Prompt cache |
| :--- | :--- | :--- | :--- | :--- |
| **Claude** (Anthropic) | an Anthropic API key | Messages | adaptive thinking with `output_config.effort`, `budget_tokens` on older models | `cache_control` on the last tool, the system prompt, the largest document and the last block |
| **ChatGPT** (OpenAI) | an OpenAI API key | Responses (`/v1/responses`), Chat Completions as a fallback | `reasoning.effort` with summaries | `prompt_cache_key` per chat |
| **Gemini** (Google) | a Google AI API key | `streamGenerateContent` (SSE) | `thinkingLevel` (3.x) or `thinkingBudget` (2.5) | implicit |
| **DeepSeek** | a DeepSeek API key | Chat Completions | `reasoning_content`, shown as **Thought process** | prefix cache |
| **Ollama** | Ollama on your computer or home network | OpenAI-compatible | depends on the model | local |
| **Custom** | a base URL, an optional key and a model name | OpenAI-compatible | depends on the endpoint | depends on the endpoint |

The adapters live in `src/chat/adapters/` and use plain `fetch`, no SDKs. They all stream into one
event format, so the chat, the tool cards and the Thought process card behave the same for every
provider. Per-model rules (families, effort mapping, context windows) are in `src/chat/models.ts`.

## Set up a provider

1. Open **Settings, AI models**.
2. Paste your API key for Claude, ChatGPT, Gemini or DeepSeek, or add a custom endpoint with its base
   URL, key and model name.
3. Press **Test connection**. It checks the key and lists the models the endpoint offers.
4. Pick the default provider and model. You can switch for a single chat with `/model` or the model
   menu in the chat header.

For fully local work, install [Ollama](https://ollama.com), pull a model with tool support (for
example `ollama pull qwen2.5:7b`) and make Ollama the default.

## Where your key is kept

| Setup | Storage | Who can read it |
| :--- | :--- | :--- |
| Desktop with the backend running | `~/OpenCraft/config.json` (mode `0600` on macOS and Linux) | the backend only; the page sees a masked hint |
| iPad in browser mode | memory, until you reload | the open page |
| iPad in browser mode, after you opt in | the browser's `localStorage`, unencrypted | anything with access to that browser profile; OpenCraft warns you first |

On the desktop, requests go from the backend straight to the provider. They never pass through an
OpenCraft server. Only browser mode on the iPad sends requests from the browser itself.

## What a provider receives

When you send a chat to a cloud model, that provider receives:

- your message and the earlier messages of the chat;
- the text of files you mention with `@` or attach, and images you attach;
- the results of tools the model called in that answer, for example the rows of a sheet it read;
- passages from the project memory and your personal context;
- the list of tool definitions.

The **audit log** (Settings, Audit log) records every outgoing request with its destination, model,
size and the names of attached files, never their content. **Local-only mode** (Settings, Privacy)
blocks every cloud provider; Ollama and endpoints on `localhost`, `127.x`, `10.x`, `172.16-31.x`,
`192.168.x` and `.local` names keep working.

## Effort and reasoning

The model chip in the prompt bar sets the effort per provider: **Auto, Off, Low, Medium, High, Max**.
`src/chat/models.ts` maps it to each API: for example Off becomes `minimal` on GPT-5 and Gemini 3, and
stays on for Claude models that always think.

Reasoning streams into a collapsible **Thought process** card above the answer. In tool chains, the
reasoning of earlier turns is replayed to the API with its signature or encrypted content, as each
API requires.

## Attachments

PDFs and images attached with `@` go to Claude, Gemini and ChatGPT as native document and image
blocks (up to 8 per message, 20 MB each). DeepSeek, Ollama and custom endpoints receive the extracted
text. Images reach a model only if it reads images.

## Token counts, cache and costs

| Provider | Token count |
| :--- | :--- |
| DeepSeek | exact, with the built-in V4 tokenizer (`src/core/bpe.ts`) |
| ChatGPT | exact, with `o200k_base` or `cl100k_base` (`gpt-tokenizer`, backend only) |
| Claude, Gemini | estimated (marked ≈), or exact with **Remote counting**, which asks their counting endpoints and sends the text to the provider (off by default) |

- The **chat footer** shows the tokens of the chat, the cache hit ratio and the size of the next
  request while you type. The bar shows the share of the model's context window; it turns orange when
  the backend will shorten the request to fit, red when even that is not enough.
- **Settings, Usage and telemetry** shows per provider and model: requests, input, cache hits and
  misses, output, thinking tokens, estimated cost, cache savings, tokens per second and time to the
  first token. Costs appear once you enter your provider's rates; OpenCraft ships no price list.
  Local models always cost $0.00.
- Everything is stored in `~/OpenCraft/usage.json` (numbers only) and never sent anywhere.

## DeepSeek

OpenCraft is tuned for the DeepSeek API (`deepseek-flash`, `deepseek-v4-pro`, base URL
`https://api.deepseek.com`):

- **Exact counts** with a TypeScript port of the V4 tokenizer, checked against the reference
  implementation on 9,866 texts.
- **Context budget**: a request that would not fit is shortened instead of failing: first
  `max_tokens`, then old tool results, then large attachments, then the oldest turns. The stored chat
  stays complete.
- **Prefix caching**: every request starts the same way (system prompt, sorted tools, frozen project
  context), so earlier parts are served from DeepSeek's cache.
- **Presets**: Standard chat, Thinking, Deep thinking, and Coding and FIM. The last one powers
  `Alt+\` completions in the code editor.

## Team Mode

The **Single / Team** switch in the chat header turns on Team Mode: a Team Leader plans the prompt as a
task graph and specialist agents work in parallel.

| Role | Mention | Tools |
| :--- | :--- | :--- |
| Team Leader | `@leader` | none: plans, reviews, writes the answer |
| Data and Sheet Specialist | `@grid-agent` | GridCraft |
| Document and Copy Specialist | `@word-agent` | WordCraft |
| Presentation Specialist | `@deck-agent` | DeckCraft |
| PDF and Compliance Specialist | `@pdf-agent` | PdfCraft |
| Code and System Specialist | `@dev-agent` | code, terminal, Git, external MCP servers |

Each role can use its own provider, model and effort, so you can mix a cloud leader with local Ollama
specialists. Configure it with `/roster` or **Settings, Team Mode**; presets include Full Studio Team,
Financial Audit Team, Fullstack Dev Team and Fast Local/Hybrid Team. Usage is tracked per role.

`@team`, `@leader` or `/team <prompt>` run the whole team. One specialist mentioned alone works
directly, without planning.
