# oura-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Oura Ring API v2](https://cloud.ouraring.com/v2/docs). It gives Claude (or any MCP client) your daily HRV, resting heart rate, sleep and readiness, plus longer-term trends against your own baseline.

Written in TypeScript on the official MCP SDK, so it runs anywhere Node 20.12+ runs, including `npx` from Claude Desktop and Claude Code.

## Tools

| Tool | What it returns |
| --- | --- |
| `oura_daily_summary` | One day (default: today, which is last night's sleep): HRV, resting HR, sleep score, readiness, total sleep, efficiency, latency, deep/REM/light/awake minutes, bed times, temperature deviation, contributors, and how each headline number compares with your previous 30 days. If today hasn't synced yet, it falls back to the latest day with data and says so. |
| `oura_trends` | A range (`days`: 7, 30, 90… or `start_date`/`end_date`): average, min, max, standard deviation, latest value and slope per week for HRV, resting HR, sleep score, readiness, total sleep and efficiency; change versus the equally long period before; comparison with a baseline window (default 60 days) with a z-score and "within / above / below normal range"; weekly averages for ranges of 21+ days; missing days; optional per-day values. |
| `oura_get_sleep_periods` | Raw `/v2/usercollection/sleep` periods (naps included). Per-sample HR/HRV arrays only with `include_samples: true`. |
| `oura_get_daily_sleep` | Raw `/v2/usercollection/daily_sleep` documents. |
| `oura_get_daily_readiness` | Raw `/v2/usercollection/daily_readiness` documents. |

How the numbers are picked:

- **HRV** is `average_hrv` from the night's main sleep period, and **resting heart rate** is that period's `lowest_heart_rate`, which is what the Oura app shows.
- The main period is the longest `long_sleep`, falling back to the longest `sleep`. Naps, rest periods and deleted periods are left out.
- Oura files a night under the day you woke up.
- "Improving" respects direction: higher is better for HRV and scores, lower is better for resting HR. Changes inside a small band (2 ms HRV, 1 bpm, 2 score points, 15 min of sleep, 1% efficiency) count as stable.

It also handles pagination (`next_token`), missing days, 429 rate limits (honours `Retry-After`, then exponential backoff) and 5xx retries. The detailed sleep endpoint has been seen treating `end_date` as exclusive, so queries are widened by a day on each side and filtered back to the range you asked for.

## Setup

### 1. Create an Oura API application

Oura retired personal access tokens at the end of 2025, so the API now needs OAuth2. You need an active Oura membership for data to come back.

1. Sign in at <https://cloud.ouraring.com/oauth/applications> and create a new application.
2. Add the redirect URI `http://localhost:8787/callback`.
3. Copy the **Client ID** and **Client Secret**.

### 2. Install and sign in

```bash
git clone https://github.com/scottolsen/oura-mcp.git
cd oura-mcp
npm install            # also builds dist/
cp .env.example .env   # fill in OURA_CLIENT_ID and OURA_CLIENT_SECRET
npm run auth
```

`npm run auth` prints an Oura sign-in link, catches the redirect on `localhost:8787`, and saves the tokens to `~/.config/oura-mcp/tokens.json` (mode 600). Access tokens last about 30 days; the server refreshes them on its own and saves each new refresh token, because Oura's refresh tokens are single use. If the refresh token is ever lost, run `npm run auth` again.

### 3. Add it to Claude

**Claude Code**

```bash
claude mcp add oura --scope user \
  -e OURA_CLIENT_ID=your-client-id \
  -e OURA_CLIENT_SECRET=your-client-secret \
  -e OURA_TIMEZONE=America/Chicago \
  -- node /absolute/path/to/oura-mcp/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS)

```json
{
  "mcpServers": {
    "oura": {
      "command": "node",
      "args": ["/absolute/path/to/oura-mcp/dist/index.js"],
      "env": {
        "OURA_CLIENT_ID": "your-client-id",
        "OURA_CLIENT_SECRET": "your-client-secret",
        "OURA_TIMEZONE": "America/Chicago"
      }
    }
  }
}
```

The client ID and secret are only used to refresh tokens. Then ask things like "How did I sleep last night?", "Is my HRV trending up over the last 90 days?" or "Compare my resting heart rate this month with last month."

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OURA_CLIENT_ID` | | OAuth app client ID (sign-in and refresh) |
| `OURA_CLIENT_SECRET` | | OAuth app client secret |
| `OURA_REDIRECT_URI` | `http://localhost:8787/callback` | Must match the app's redirect URI |
| `OURA_TOKEN_FILE` | `~/.config/oura-mcp/tokens.json` | Where tokens are kept |
| `OURA_TIMEZONE` | system zone | Decides what "today" is |
| `OURA_ACCESS_TOKEN` | | Use this token directly instead of the token file (not refreshed) |

## Daily updates

An MCP server only answers when a client calls it. For a morning update, have something call `oura_daily_summary` on a schedule, for example a scheduled task in Claude Desktop or Claude Code ("Every morning at 8, summarize my Oura data with oura_daily_summary and oura_trends for 7 days"), or a cron job running `claude -p` with this server configured.

## Development

```bash
npm install
npm test          # vitest, all Oura responses mocked
npx tsc --noEmit  # typecheck src and tests
npm run build
```

Tokens and `.env` are git-ignored. Never commit them.

## License

MIT
