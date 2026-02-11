# Last.fm Tracker

A Cloudflare Durable Object that polls Last.fm and broadcasts "now playing" track updates via WebSocket. Used on [charliegleason.com](https://charliegleason.com) to show what I'm currently listening to.

> **Note:** This is a public mirror of `apps/lastfm-tracker/` from a private monorepo. It's automatically synced on every push to main.

## How it works

1. Clients connect via WebSocket
2. On the first connection, the Durable Object starts polling Last.fm every 30 seconds
3. When the track changes, it broadcasts the update to all connected clients
4. Uses [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) for reliable polling and [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/) for efficiency
5. Polling stops automatically when the last client disconnects

## Development

```sh
# Install dependencies
pnpm install

# Copy environment variables
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Last.fm API key and username

# Start dev server
pnpm dev

# Deploy to Cloudflare
pnpm deploy
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `LASTFM_API_KEY` | Your Last.fm API key ([get one here](https://www.last.fm/api/account/create)) |
| `LASTFM_USERNAME` | The Last.fm username to track |

For production, set these as Cloudflare secrets:

```sh
pnpm wrangler secret put LASTFM_API_KEY
pnpm wrangler secret put LASTFM_USERNAME
```

## Usage

Connect via WebSocket to receive real-time track updates:

```ts
const ws = new WebSocket("wss://lastfm-tracker.superhighfives.workers.dev");

ws.onmessage = (event) => {
  const { track } = JSON.parse(event.data);
  if (track) {
    console.log(`Now playing: ${track.name} by ${track.artist}`);
    console.log(`Currently playing: ${track.isNowPlaying}`);
  }
};

// Request current track manually
ws.send("ping");
```

## Tech stack

- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) - Stateful edge compute
- [Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) - Scheduled polling
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/) - Cost-efficient WebSocket handling
- [Last.fm API](https://www.last.fm/api) - Music data
- [TypeScript](https://www.typescriptlang.org/)

## Related

- [charliegleason.com](https://github.com/superhighfives/charliegleason.com) - Main site that uses this
- [visitor-counter](https://github.com/superhighfives/visitor-counter) - Companion Durable Object for visitor tracking
