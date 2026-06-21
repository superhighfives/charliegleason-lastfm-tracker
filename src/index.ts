import { DurableObject } from "cloudflare:workers";

export interface Env {
  LASTFM_TRACKER: DurableObjectNamespace<LastFmTracker>;
  LASTFM_API_KEY: string;
  LASTFM_USERNAME: string;
}

interface Track {
  name: string;
  artist: string;
  isNowPlaying: boolean;
}

interface LastFmResponse {
  recenttracks?: {
    track?: Array<{
      name: string;
      artist: { "#text": string };
      "@attr"?: { nowplaying: string };
    }>;
  };
}

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Durable Object that polls Last.fm and broadcasts track updates via WebSocket.
 * Uses Alarms for reliable polling and WebSocket Hibernation for efficiency.
 */
export class LastFmTracker extends DurableObject<Env> {
  private currentTrack: Track | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Restore cached track from storage on cold start
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<Track>("currentTrack");
      if (stored) {
        this.currentTrack = stored;
      }
    });
  }

  /**
   * Handles incoming WebSocket upgrade requests.
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      // Non-WebSocket request: return the current track as JSON. Used by
      // clients that poll over plain HTTP (e.g. the SSH terminal, whose
      // runtime can't complete a WebSocket upgrade against Cloudflare).
      // ensureAlarm keeps polling alive so the snapshot stays fresh even with
      // no WebSocket subscribers.
      await this.ensureAlarm();
      return Response.json(
        { track: this.currentTrack },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket with hibernation support
    this.ctx.acceptWebSocket(server);

    // Send current track immediately if we have one
    if (this.currentTrack) {
      server.send(JSON.stringify({ track: this.currentTrack }));
    }

    // Ensure alarm is set for polling
    await this.ensureAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Called when a WebSocket message is received.
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Clients can send "ping" to get current track
    if (message === "ping") {
      ws.send(JSON.stringify({ track: this.currentTrack }));
    }
  }

  /**
   * Called when a WebSocket connection is closed.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close(code, reason);
  }

  /**
   * Called when a WebSocket error occurs.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    ws.close(1011, "WebSocket error");
  }

  /**
   * Called when the alarm fires - polls Last.fm API.
   */
  async alarm(): Promise<void> {
    await this.pollLastFm();
    // Schedule next poll if we have active connections
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  /**
   * Ensures an alarm is set for polling.
   */
  private async ensureAlarm(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      // Poll immediately on first connection, then schedule next
      await this.pollLastFm();
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  /**
   * Fetches the latest track from Last.fm API.
   */
  private async pollLastFm(): Promise<void> {
    try {
      const url = new URL("https://ws.audioscrobbler.com/2.0/");
      url.searchParams.set("method", "user.getrecenttracks");
      url.searchParams.set("user", this.env.LASTFM_USERNAME);
      url.searchParams.set("api_key", this.env.LASTFM_API_KEY);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");

      const response = await fetch(url.toString());
      if (!response.ok) {
        console.error("Last.fm API error:", response.status);
        return;
      }

      const data: LastFmResponse = await response.json();
      const trackData = data.recenttracks?.track?.[0];

      if (!trackData) {
        return;
      }

      const track: Track = {
        name: trackData.name,
        artist: trackData.artist["#text"],
        isNowPlaying: trackData["@attr"]?.nowplaying === "true",
      };

      // Only broadcast if track changed
      const trackChanged =
        !this.currentTrack ||
        this.currentTrack.name !== track.name ||
        this.currentTrack.artist !== track.artist ||
        this.currentTrack.isNowPlaying !== track.isNowPlaying;

      if (trackChanged) {
        this.currentTrack = track;
        await this.ctx.storage.put("currentTrack", track);
        this.broadcast(track);
      }
    } catch (error) {
      console.error("Failed to poll Last.fm:", error);
    }
  }

  /**
   * Broadcasts track update to all connected clients.
   */
  private broadcast(track: Track): void {
    const message = JSON.stringify({ track });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Connection might be closed, ignore
      }
    }
  }
}

/**
 * Worker entry point - handles direct WebSocket connections.
 * Routes requests to a single global LastFmTracker DO instance.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Upgrade, Connection",
        },
      });
    }

    // Route to the global DO instance
    const id = env.LASTFM_TRACKER.idFromName("global");
    const stub = env.LASTFM_TRACKER.get(id);

    // Forward the request to the DO
    const response = await stub.fetch(request);

    // Add CORS headers to the response
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");

    return newResponse;
  },
};
