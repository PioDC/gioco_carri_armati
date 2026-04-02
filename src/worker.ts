import { DurableObject } from "cloudflare:workers";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROOM_IDLE_TTL_MS,
  SNAPSHOT_INTERVAL_MS,
  TICK_RATE
} from "./shared/constants";
import {
  createEmptyInput,
  createInitialGameState,
  createPlayerState,
  createSnapshot,
  startMatch,
  stepGame,
  type ServerGameState
} from "./shared/game";
import type {
  ClientMessage,
  CreateRoomResponse,
  JoinRoomRequest,
  LobbyState,
  ServerMessage
} from "./shared/types";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface SessionRecord {
  playerId: string;
  token: string;
}

interface RoomMetadata {
  roomCode: string;
  hostId: string | null;
  sessions: Record<string, SessionRecord>;
  createdAt: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function createRoom(env: Env, request: Request): Promise<Response> {
  const payload = (await readJson<JoinRoomRequest>(request)) ?? { nickname: "" };
  const nickname = payload.nickname?.trim().slice(0, 16);
  if (!nickname) {
    return json({ error: "Nickname required" }, 400);
  }

  const roomCode = generateRoomCode();
  const roomId = env.ROOMS.idFromName(roomCode);
  const stub = env.ROOMS.get(roomId);
  const playerId = randomId("player");
  const sessionToken = crypto.randomUUID();
  const metadata: RoomMetadata = {
    roomCode,
    hostId: playerId,
    createdAt: Date.now(),
    sessions: {
      [playerId]: { playerId, token: sessionToken }
    }
  };

  await stub.fetch("https://room.internal/internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode, playerId, nickname, metadata })
  });
  const response: CreateRoomResponse = { roomCode, playerId, sessionToken };
  return json(response, 201);
}

async function joinRoom(env: Env, request: Request, roomCode: string): Promise<Response> {
  const payload = await readJson<JoinRoomRequest>(request);
  const nickname = payload?.nickname?.trim().slice(0, 16);
  if (!nickname) {
    return json({ error: "Nickname required" }, 400);
  }

  const roomId = env.ROOMS.idFromName(roomCode);
  const stub = env.ROOMS.get(roomId);
  const playerId = randomId("player");
  const sessionToken = crypto.randomUUID();
  const joinResponse = await stub.fetch("https://room.internal/internal/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode, playerId, nickname, sessionToken })
  });
  const result = (await joinResponse.json()) as { ok: boolean; status: number; error?: string };
  if (!result.ok) {
    return json({ error: result.error }, result.status);
  }

  return json({
    roomCode,
    playerId,
    sessionToken
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return createRoom(env, request);
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/join$/);
    if (request.method === "POST" && joinMatch) {
      return joinRoom(env, request, joinMatch[1]);
    }

    const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/);
    if (request.method === "GET" && socketMatch) {
      const roomId = env.ROOMS.idFromName(socketMatch[1]);
      const stub = env.ROOMS.get(roomId);
      return stub.fetch(request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

type RoomInitPayload = {
  roomCode: string;
  playerId: string;
  nickname: string;
  metadata: RoomMetadata;
};

type RoomJoinPayload = {
  roomCode: string;
  playerId: string;
  nickname: string;
  sessionToken: string;
};

export class RoomDurableObject extends DurableObject<Env> {
  private stateData: ServerGameState;
  private roomCode: string;
  private sessions: Record<string, SessionRecord>;
  private hostId: string | null;
  private sockets = new Map<string, WebSocket>();
  private tickAlarm = false;
  private lastSnapshotAt = 0;
  private lastActiveAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.roomCode = ctx.id.toString().slice(0, 5);
    this.stateData = createInitialGameState(this.roomCode);
    this.sessions = {};
    this.hostId = null;
    ctx.blockConcurrencyWhile(async () => {
      const metadata = await ctx.storage.get<RoomMetadata>("metadata");
      const storedState = await ctx.storage.get<ServerGameState>("gameState");
      if (metadata) {
        this.roomCode = metadata.roomCode;
        this.sessions = metadata.sessions;
        this.hostId = metadata.hostId;
      }
      if (storedState) {
        this.stateData = storedState;
      } else if (metadata) {
        this.stateData = createInitialGameState(metadata.roomCode);
      }
    });
  }

  async initializeRoom(payload: RoomInitPayload): Promise<void> {
    this.roomCode = payload.roomCode;
    this.stateData = createInitialGameState(payload.roomCode);
    this.sessions = payload.metadata.sessions;
    this.hostId = payload.metadata.hostId;
    this.stateData.players[payload.playerId] = {
      state: createPlayerState(payload.playerId, payload.nickname, 0),
      input: createEmptyInput(),
      lastShotAt: 0
    };
    this.lastActiveAt = Date.now();
    await this.persist();
  }

  async joinRoom(payload: RoomJoinPayload): Promise<{ ok: boolean; status: number; error?: string }> {
    if (!this.stateData.roomCode || this.stateData.roomCode !== payload.roomCode) {
      this.roomCode = payload.roomCode;
      this.stateData.roomCode = payload.roomCode;
    }

    if (this.stateData.phase !== "lobby") {
      return { ok: false, status: 409, error: "Match already started" };
    }

    const playerCount = Object.keys(this.stateData.players).length;
    if (playerCount >= MAX_PLAYERS) {
      return { ok: false, status: 409, error: "Room is full" };
    }

    this.sessions[payload.playerId] = {
      playerId: payload.playerId,
      token: payload.sessionToken
    };

    this.stateData.players[payload.playerId] = {
      state: createPlayerState(payload.playerId, payload.nickname, playerCount),
      input: createEmptyInput(),
      lastShotAt: 0
    };
    this.lastActiveAt = Date.now();
    void this.persist();
    this.broadcast({ type: "lobby_state", lobby: this.getLobbyState() });
    return { ok: true, status: 200 };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/init") {
      const payload = await request.json<RoomInitPayload>();
      await this.initializeRoom(payload);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/join") {
      const payload = await request.json<RoomJoinPayload>();
      return json(await this.joinRoom(payload));
    }

    if (url.pathname.endsWith("/ws")) {
      return this.handleWebSocket(request, url);
    }
    return json({ error: "Not found" }, 404);
  }

  async alarm(): Promise<void> {
    if (!this.tickAlarm) {
      return;
    }

    this.tickLoop();
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const playerId = url.searchParams.get("playerId");
    const token = url.searchParams.get("token");
    if (!playerId || !token) {
      return json({ error: "Missing credentials" }, 401);
    }

    const session = this.sessions[playerId];
    if (!session || session.token !== token) {
      return json({ error: "Invalid credentials" }, 403);
    }

    const player = this.stateData.players[playerId];
    if (!player) {
      return json({ error: "Unknown player" }, 404);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.lastActiveAt = Date.now();
    player.state.connected = true;
    this.sockets.set(playerId, server);

    server.addEventListener("message", (event) => {
      this.onSocketMessage(playerId, event.data);
    });
    server.addEventListener("close", () => {
      this.onSocketClose(playerId);
    });

    this.send(playerId, { type: "lobby_state", lobby: this.getLobbyState() });
    if (this.stateData.phase === "playing" || this.stateData.phase === "finished") {
      this.send(playerId, {
        type: this.stateData.phase === "playing" ? "match_start" : "state_snapshot",
        snapshot: createSnapshot(this.stateData)
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private onSocketMessage(playerId: string, raw: string | ArrayBuffer): void {
    this.lastActiveAt = Date.now();
    const player = this.stateData.players[playerId];
    if (!player) {
      return;
    }

    try {
      const message = JSON.parse(String(raw)) as ClientMessage;
      if (message.type === "ready" && this.stateData.phase === "lobby") {
        player.state.ready = message.ready;
        void this.persist();
        this.broadcast({ type: "lobby_state", lobby: this.getLobbyState() });
        this.maybeStartMatch();
        return;
      }

      if (message.type === "input" && this.stateData.phase === "playing") {
        player.input = message.input;
        return;
      }

      if (message.type === "ping") {
        this.send(playerId, { type: "pong", timestamp: message.timestamp });
      }
    } catch {
      this.send(playerId, { type: "error", message: "Invalid message" });
    }
  }

  private onSocketClose(playerId: string): void {
    this.sockets.delete(playerId);
    const player = this.stateData.players[playerId];
    if (!player) {
      return;
    }

    player.state.connected = false;
    player.state.ready = false;
    player.input = createEmptyInput();
    this.lastActiveAt = Date.now();
    void this.persist();

    if (this.stateData.phase === "lobby") {
      this.broadcast({ type: "lobby_state", lobby: this.getLobbyState() });
      return;
    }

    if (this.stateData.phase === "playing") {
      player.state.alive = false;
      const alivePlayers = Object.values(this.stateData.players).filter(
        (record) => record.state.connected && record.state.alive
      );
      if (alivePlayers.length <= 1) {
        this.stateData.phase = "finished";
        this.stateData.winnerId = alivePlayers[0]?.state.id ?? null;
        void this.persist();
        this.broadcast({
          type: "match_end",
          snapshot: createSnapshot(this.stateData),
          reason: "abandon"
        });
      }
    }
  }

  private maybeStartMatch(): void {
    const players = Object.values(this.stateData.players);
    const connectedPlayers = players.filter((record) => record.state.connected);
    const readyPlayers = connectedPlayers.filter((record) => record.state.ready);

    if (connectedPlayers.length < MIN_PLAYERS || readyPlayers.length !== connectedPlayers.length) {
      return;
    }

    startMatch(this.stateData, Date.now());
    this.tickAlarm = true;
    this.lastSnapshotAt = 0;
    void this.persist();
    this.scheduleNextTick();
    this.broadcast({ type: "match_start", snapshot: createSnapshot(this.stateData) });
  }

  private tickLoop(): void {
    if (!this.tickAlarm || this.stateData.phase !== "playing") {
      return;
    }

    const now = Date.now();
    const outcome = stepGame(this.stateData, 1000 / TICK_RATE, now);

    outcome.damaged.forEach((entry) => {
      this.broadcast({ type: "player_damaged", playerId: entry.playerId, hp: entry.hp });
    });
    outcome.eliminated.forEach((playerId) => {
      this.broadcast({ type: "player_eliminated", playerId });
    });

    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotAt = now;
      this.broadcast({ type: "state_snapshot", snapshot: createSnapshot(this.stateData) });
    }

    if (outcome.endedReason) {
      this.tickAlarm = false;
      void this.persist();
      this.broadcast({
        type: "match_end",
        snapshot: createSnapshot(this.stateData),
        reason: outcome.endedReason
      });
      return;
    }

    if (now - this.lastActiveAt > ROOM_IDLE_TTL_MS) {
      this.tickAlarm = false;
      this.stateData.phase = "finished";
      this.stateData.winnerId = null;
      void this.persist();
      return;
    }

    void this.persist();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    this.ctx.storage.setAlarm(Date.now() + Math.floor(1000 / TICK_RATE));
  }

  private getLobbyState(): LobbyState {
    return {
      roomCode: this.roomCode,
      phase: this.stateData.phase,
      hostId: this.hostId,
      players: Object.values(this.stateData.players).map((record) => ({
        id: record.state.id,
        nickname: record.state.nickname,
        ready: record.state.ready,
        connected: record.state.connected
      }))
    };
  }

  private send(playerId: string, message: ServerMessage): void {
    const socket = this.sockets.get(playerId);
    if (!socket) {
      return;
    }

    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.sockets.delete(playerId);
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const playerId of this.sockets.keys()) {
      this.send(playerId, message);
    }
  }

  private persist(): Promise<void> {
    const metadata: RoomMetadata = {
      roomCode: this.roomCode,
      hostId: this.hostId,
      sessions: this.sessions,
      createdAt: this.lastActiveAt
    };
    return this.ctx.storage.put({
      metadata,
      gameState: this.stateData
    });
  }
}
