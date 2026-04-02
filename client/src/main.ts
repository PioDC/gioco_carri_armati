import Phaser from "phaser";
import "./style.css";
import { GAME_HEIGHT, GAME_WIDTH, MAX_HP, TURRET_FORWARD_OFFSET } from "../../src/shared/constants";
import type {
  ClientMessage,
  CreateRoomResponse,
  GameSnapshot,
  JoinRoomResponse,
  LobbyState,
  PlayerState,
  ServerMessage
} from "../../src/shared/types";

type AppScreen = "menu" | "lobby" | "game" | "result";

interface Session {
  roomCode: string;
  playerId: string;
  sessionToken: string;
  nickname: string;
}

interface AppState {
  screen: AppScreen;
  session: Session | null;
  lobby: LobbyState | null;
  snapshot: GameSnapshot | null;
  status: string;
  resultText: string | null;
  latencyMs: number | null;
}

const state: AppState = {
  screen: "menu",
  session: null,
  lobby: null,
  snapshot: null,
  status: "Create a room or join one with a code.",
  resultText: null,
  latencyMs: null
};

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) {
  throw new Error("Missing #app");
}
const app: HTMLDivElement = appElement;

let connection: GameConnection | null = null;
let game: Phaser.Game | null = null;

function getApiBase(): string {
  return window.location.origin;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class GameConnection {
  private socket: WebSocket | null = null;
  private pingTimer = 0;

  constructor(
    private readonly session: Session,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onStatus: (status: string) => void
  ) {}

  connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${protocol}://${window.location.host}/api/rooms/${this.session.roomCode}/ws` +
      `?playerId=${encodeURIComponent(this.session.playerId)}` +
      `&token=${encodeURIComponent(this.session.sessionToken)}`;

    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.onStatus("Connected");
      this.startPing();
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.onMessage(message);
    });
    this.socket.addEventListener("close", () => {
      this.stopPing();
      this.onStatus("Disconnected");
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.stopPing();
    this.socket?.close();
    this.socket = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: "ping", timestamp: Date.now() });
    }, 4000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = 0;
    }
  }
}

class ArenaScene extends Phaser.Scene {
  private cursors!: Record<string, Phaser.Input.Keyboard.Key>;
  private tanks = new Map<string, { body: Phaser.GameObjects.Rectangle; turret: Phaser.GameObjects.Rectangle }>();
  private bullets = new Map<string, Phaser.GameObjects.Arc>();
  private obstacles = new Map<string, Phaser.GameObjects.Rectangle>();
  private lastSeq = 0;

  constructor() {
    super("arena");
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#132028");
    this.cursors = this.input.keyboard?.addKeys({
      forward: Phaser.Input.Keyboard.KeyCodes.W,
      backward: Phaser.Input.Keyboard.KeyCodes.S,
      rotateLeft: Phaser.Input.Keyboard.KeyCodes.A,
      rotateRight: Phaser.Input.Keyboard.KeyCodes.D,
      turretLeft: Phaser.Input.Keyboard.KeyCodes.LEFT,
      turretRight: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      fire: Phaser.Input.Keyboard.KeyCodes.SPACE
    }) as Record<string, Phaser.Input.Keyboard.Key>;
  }

  update(): void {
    if (!state.snapshot || !state.session || !connection) {
      return;
    }

    this.syncSnapshot(state.snapshot);
    this.lastSeq += 1;
    connection.send({
      type: "input",
      input: {
        forward: this.cursors.forward.isDown,
        backward: this.cursors.backward.isDown,
        rotateLeft: this.cursors.rotateLeft.isDown,
        rotateRight: this.cursors.rotateRight.isDown,
        turretLeft: this.cursors.turretLeft.isDown,
        turretRight: this.cursors.turretRight.isDown,
        fire: this.cursors.fire.isDown,
        seq: this.lastSeq
      }
    });
  }

  private syncSnapshot(snapshot: GameSnapshot): void {
    for (const obstacle of snapshot.obstacles) {
      if (this.obstacles.has(obstacle.id)) {
        continue;
      }
      const rect = this.add.rectangle(
        obstacle.x + obstacle.width / 2,
        obstacle.y + obstacle.height / 2,
        obstacle.width,
        obstacle.height,
        0x3d5a40
      );
      this.obstacles.set(obstacle.id, rect);
    }

    const activePlayerIds = new Set(snapshot.players.map((player) => player.id));
    for (const [playerId, visuals] of this.tanks) {
      if (activePlayerIds.has(playerId)) {
        continue;
      }
      visuals.body.destroy();
      visuals.turret.destroy();
      this.tanks.delete(playerId);
    }

    snapshot.players.forEach((player) => this.renderPlayer(player));

    const activeBulletIds = new Set(snapshot.bullets.map((bullet) => bullet.id));
    for (const [bulletId, arc] of this.bullets) {
      if (activeBulletIds.has(bulletId)) {
        continue;
      }
      arc.destroy();
      this.bullets.delete(bulletId);
    }
    snapshot.bullets.forEach((bullet) => {
      let arc = this.bullets.get(bullet.id);
      if (!arc) {
        arc = this.add.circle(bullet.position.x, bullet.position.y, 4, 0xf4a261);
        this.bullets.set(bullet.id, arc);
      }
      arc.setPosition(bullet.position.x, bullet.position.y);
    });
  }

  private renderPlayer(player: PlayerState): void {
    let visuals = this.tanks.get(player.id);
    if (!visuals) {
      const body = this.add.rectangle(player.position.x, player.position.y, 40, 28, 0x5dade2);
      const turret = this.add.rectangle(player.position.x, player.position.y, 34, 10, 0xe9c46a);
      visuals = { body, turret };
      this.tanks.set(player.id, visuals);
    }

    const color = player.id === state.session?.playerId ? 0x2a9d8f : player.alive ? 0x5dade2 : 0x6c757d;
    visuals.body.setFillStyle(color);
    visuals.body.setPosition(player.position.x, player.position.y);
    visuals.body.setRotation(player.bodyRotation);
    visuals.turret.setPosition(
      player.position.x + Math.cos(player.turretRotation) * TURRET_FORWARD_OFFSET,
      player.position.y + Math.sin(player.turretRotation) * TURRET_FORWARD_OFFSET
    );
    visuals.turret.setRotation(player.turretRotation);
  }
}

function destroyGame(): void {
  if (game) {
    game.destroy(true);
    game = null;
  }
}

function mountGame(): void {
  destroyGame();
  game = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent: "phaser-root",
    scene: [ArenaScene]
  });
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "lobby_state":
      state.lobby = message.lobby;
      state.screen = "lobby";
      render();
      return;
    case "match_start":
      state.snapshot = message.snapshot;
      state.screen = "game";
      render();
      return;
    case "state_snapshot":
      state.snapshot = message.snapshot;
      if (state.screen !== "game") {
        state.screen = "game";
        render();
      } else {
        updateHud();
      }
      return;
    case "player_damaged":
      updateHud();
      return;
    case "player_eliminated":
      updateHud();
      return;
    case "match_end":
      state.snapshot = message.snapshot;
      state.resultText = buildResultText(message.snapshot);
      state.screen = "result";
      render();
      return;
    case "pong":
      state.latencyMs = Date.now() - message.timestamp;
      updateHud();
      return;
    case "error":
      state.status = message.message;
      render();
  }
}

function buildResultText(snapshot: GameSnapshot): string {
  if (!snapshot.winnerId) {
    return "Round ended in a draw.";
  }
  const winner = snapshot.players.find((player) => player.id === snapshot.winnerId);
  return `${winner?.nickname ?? "Unknown"} wins the round.`;
}

function updateHud(): void {
  const hud = document.querySelector<HTMLDivElement>("#hud");
  if (!hud || !state.snapshot || !state.session) {
    return;
  }

  const player = state.snapshot.players.find((entry) => entry.id === state.session?.playerId);
  const aliveCount = state.snapshot.players.filter((entry) => entry.alive && entry.connected).length;
  hud.innerHTML = `
    <div>Room <strong>${escapeHtml(state.session.roomCode)}</strong></div>
    <div>HP <strong>${player?.hp ?? MAX_HP}/${MAX_HP}</strong></div>
    <div>Alive <strong>${aliveCount}</strong></div>
    <div>Ping <strong>${state.latencyMs ?? "-"} ms</strong></div>
  `;
}

async function createRoom(nickname: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname })
  });
  if (!response.ok) {
    state.status = "Failed to create room.";
    render();
    return;
  }

  const data = (await response.json()) as CreateRoomResponse;
  connectSession({ ...data, nickname });
}

async function joinRoom(roomCode: string, nickname: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/api/rooms/${roomCode}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname })
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: "Join failed" }))) as { error: string };
    state.status = error.error;
    render();
    return;
  }

  const data = (await response.json()) as JoinRoomResponse;
  connectSession({ ...data, nickname });
}

function connectSession(session: Session): void {
  connection?.close();
  destroyGame();
  state.session = session;
  state.status = "Connecting...";
  state.snapshot = null;
  state.resultText = null;
  state.lobby = null;
  connection = new GameConnection(session, handleServerMessage, (status) => {
    state.status = status;
    render();
  });
  connection.connect();
  render();
}

function renderMenu(): string {
  return `
    <div class="shell">
      <div class="panel">
        <div class="hero">
          <div>
            <h1>Tank Arena</h1>
            <p>Cloudflare multiplayer prototype for 2-4 tank commanders.</p>
            <p class="muted">W forward, S backward, A turns left, D turns right, left/right arrows rotate the turret, Space fires. Four hits to destroy a tank.</p>
          </div>
          <div>
            <span class="badge">Desktop Recommended</span>
            <div class="notice">${window.innerWidth < 720 ? "Small screens are not supported in the first version." : ""}</div>
          </div>
        </div>
        <div class="row">
          <input id="nickname" maxlength="16" placeholder="Nickname" value="${escapeHtml(state.session?.nickname ?? "")}" />
          <button id="create-room">Create room</button>
        </div>
        <div class="row">
          <input id="room-code" maxlength="5" placeholder="Room code" />
          <button id="join-room" class="secondary">Join room</button>
        </div>
        <p class="muted">${escapeHtml(state.status)}</p>
      </div>
    </div>
  `;
}

function renderLobby(): string {
  const lobby = state.lobby;
  const session = state.session;
  if (!lobby || !session) {
    return renderMenu();
  }

  const slots = Array.from({ length: 4 }, (_, index) => {
    const player = lobby.players[index];
    if (!player) {
      return `<div class="slot"><strong>Slot ${index + 1}</strong><span class="muted">Waiting for player</span></div>`;
    }
    return `
      <div class="slot">
        <strong>${escapeHtml(player.nickname)}${player.id === session.playerId ? " (you)" : ""}</strong>
        <div class="muted">${player.connected ? "Connected" : "Offline"}</div>
        <div class="badge">${player.ready ? "Ready" : "Not ready"}</div>
      </div>
    `;
  }).join("");

  const me = lobby.players.find((player) => player.id === session.playerId);
  return `
    <div class="shell">
      <div class="panel">
        <div class="hero">
          <div>
            <h2>Room ${escapeHtml(lobby.roomCode)}</h2>
            <p class="muted">Share this code. The match starts when at least 2 connected players are ready.</p>
          </div>
          <div><span class="badge">${escapeHtml(state.status)}</span></div>
        </div>
        <div class="slots">${slots}</div>
        <div class="row">
          <button id="toggle-ready">${me?.ready ? "Cancel ready" : "Ready up"}</button>
          <button id="leave-room" class="ghost">Leave room</button>
        </div>
      </div>
    </div>
  `;
}

function renderGame(): string {
  return `
    <div class="game-shell">
      <div id="hud" class="hud"></div>
      <div class="canvas-wrap">
        <div id="phaser-root"></div>
      </div>
    </div>
  `;
}

function renderResult(): string {
  return `
    <div class="shell">
      <div class="panel">
        <h2>Round Finished</h2>
        <p>${escapeHtml(state.resultText ?? "The round is over.")}</p>
        <p class="muted">${escapeHtml(state.status)}</p>
        <div class="row">
          <button id="back-menu">Back to menu</button>
        </div>
      </div>
    </div>
  `;
}

function bindUi(): void {
  if (state.screen === "menu") {
    document.querySelector<HTMLButtonElement>("#create-room")?.addEventListener("click", () => {
      const nickname = document.querySelector<HTMLInputElement>("#nickname")?.value.trim();
      if (!nickname) {
        state.status = "Nickname required.";
        render();
        return;
      }
      void createRoom(nickname);
    });
    document.querySelector<HTMLButtonElement>("#join-room")?.addEventListener("click", () => {
      const nickname = document.querySelector<HTMLInputElement>("#nickname")?.value.trim();
      const roomCode = document.querySelector<HTMLInputElement>("#room-code")?.value.trim().toUpperCase();
      if (!nickname || !roomCode) {
        state.status = "Nickname and room code required.";
        render();
        return;
      }
      void joinRoom(roomCode, nickname);
    });
    return;
  }

  if (state.screen === "lobby") {
    document.querySelector<HTMLButtonElement>("#toggle-ready")?.addEventListener("click", () => {
      const me = state.lobby?.players.find((player) => player.id === state.session?.playerId);
      connection?.send({ type: "ready", ready: !me?.ready });
    });
    document.querySelector<HTMLButtonElement>("#leave-room")?.addEventListener("click", () => {
      connection?.close();
      connection = null;
      destroyGame();
      state.screen = "menu";
      state.lobby = null;
      state.snapshot = null;
      state.resultText = null;
      state.status = "Left room.";
      render();
    });
    return;
  }

  if (state.screen === "result") {
    document.querySelector<HTMLButtonElement>("#back-menu")?.addEventListener("click", () => {
      connection?.close();
      connection = null;
      destroyGame();
      state.screen = "menu";
      state.lobby = null;
      state.snapshot = null;
      state.resultText = null;
      state.status = "Create a room or join one with a code.";
      render();
    });
  }
}

function render(): void {
  switch (state.screen) {
    case "menu":
      destroyGame();
      app.innerHTML = renderMenu();
      break;
    case "lobby":
      destroyGame();
      app.innerHTML = renderLobby();
      break;
    case "game":
      app.innerHTML = renderGame();
      mountGame();
      updateHud();
      break;
    case "result":
      destroyGame();
      app.innerHTML = renderResult();
      break;
  }
  bindUi();
}

render();
