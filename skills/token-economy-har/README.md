# token-economy-har

[Русская версия](README.ru.md)

Token-efficient HAR parsing on Node.js without npm dependencies. Use it to summarize network requests, find slow responses, errors, the largest resources and duplicates, compare two captures and scrub secrets — without opening a multi-megabyte `.har` in context and without parsing its JSON by hand.

## Requirements

- **Node.js 18 or newer.**
- **No npm dependencies:** the directory works as a whole copy, `npm install` is not needed. `har.js` sits next to this README.
- **Input:** a `.har` file (`--file path` or `--file=path`); without `-f`/`--file`, or with `-f -`, the HAR is read from stdin. Entry indexes start at **0** and are the same in every command.

## Install

Copy the `token-economy-har` folder into the agent's skills directory. The entry point is `har.js` next to `SKILL.md`:

```powershell
node "<SKILL_DIR>\har.js" info -f "capture.har"
node "<SKILL_DIR>\har.js" slow -f "capture.har" --top 10 --min 500 --json
node "<SKILL_DIR>\har.js" entry 42 -f "capture.har" --body 2k --json
```

The order for a new capture: `info`, then `slow` or `errors`, then `content` and `dup`.

## What it does

| Command | Result |
|---|---|
| `info` | Number of requests and pages; body sizes; p50/p95/p99/max; statuses, methods, domains, MIME |
| `slow --top 10 --min 500` | Slowest requests; `blocked/dns/connect/ssl/send/wait/receive` in ms. Without `--min` the threshold is 0 |
| `errors` | HTTP >= 400, missing response, status 0, `_error`, timeouts and explicitly empty responses |
| `domains --sort size` | Sizes and total time per domain. Sort by `size` (by known uncompressed volume, default), `count`, `time`; `--top N` |
| `content` | Content categories, transferred and uncompressed size; `--by-mime` groups by MIME |
| `dup --strategy exact` | Identical URLs; `norm` removes noise and the filename hash; `hash` compares recorded response bodies |
| `search <regex> --limit 30` | A JavaScript regex over URL, method and status, case-sensitive, no flags. Does not search bodies |
| `entry N` | Request/response headers, metadata and phases. `--body 2k` additionally shows capped bodies |
| `waterfall --top 20` | The requests with the earliest starts, their offsets and durations over the recording interval |
| `diff a.har b.har` | Appeared/missing URLs, growth of average time/size and the change in request count |
| `redact -o clean.har` | A valid HAR without standard secrets; the original size figures are kept |

All commands support `--json`; `--pretty` formats JSON only together with `--json`. `--compact` is opt-in together with `--json` — read `references/compact-output.md` before use or decoding.

## Output limits

- A hard cap of 200 lines and 8 KiB applies to every command, including help; a large `--limit` does not lift it. `--limit N` bounds the number of data items (default 30; `info` 5 domains and MIME, `slow/domains` 10, `waterfall` 20; together with `--top` the smaller value applies).
- Bodies are absent from the output of every command by default. `entry N --body 2k` shows a capped body (`k/m` mean 1024/1048576 bytes, UTF-8 boundaries are kept); check `truncated`.
- JSON lists carry `total`, `shown`, `omitted`, `items`, `truncated`; JSON is never cut mid-item. `truncated: true` can mean a field was cut even with `omitted: 0`.
- Any `truncated:true` (including a field/body cut) forbids treating the output as complete.
- For files **over 200 MiB** `--stream` turns on automatically; stdin is always streamed.

## Notes

- Never open a multi-megabyte HAR with a file-reading tool and never parse its JSON by hand: even a single `response.content.text` line can span megabytes.
- `search` and `entry` do not mask secrets: URLs/query, headers and explicitly requested bodies can contain tokens and cookies. A limited output and `--compact` are not scrubbing; to hand output over, first build a cleaned HAR and analyze it.
- Before passing a HAR or its output to other people/agents, before `redact` or judging anonymity, read `references/redact.md`: automatic scrubbing does not guarantee removal of all personal data.
- Exit codes: **0** — there is data, **1** — no matching records/changes, **2** — bad arguments, a read/write error or a broken HAR. Diagnostics go to stderr; with `--json` the diagnostic message is JSON too.
- For tests/benchmark read `references/testing.md` and get the user's permission; use only your own synthetic HAR without cookies/tokens.
