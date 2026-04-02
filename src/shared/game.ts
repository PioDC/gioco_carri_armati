import {
  BODY_ROTATION_SPEED,
  BULLET_RADIUS,
  BULLET_SPEED,
  FIRE_COOLDOWN_MS,
  GAME_HEIGHT,
  GAME_WIDTH,
  MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  ROUND_DURATION_MS,
  TURRET_ROTATION_SPEED
} from "./constants";
import type {
  BulletState,
  GameSnapshot,
  Obstacle,
  PlayerInputState,
  PlayerState,
  Vec2
} from "./types";

export interface ServerPlayerRecord {
  state: PlayerState;
  input: PlayerInputState;
  lastShotAt: number;
}

export interface ServerGameState {
  roomCode: string;
  phase: "lobby" | "playing" | "finished";
  tick: number;
  roundEndsAt: number | null;
  players: Record<string, ServerPlayerRecord>;
  bullets: BulletState[];
  obstacles: Obstacle[];
  winnerId: string | null;
}

const SPAWN_POINTS: Vec2[] = [
  { x: 96, y: 96 },
  { x: GAME_WIDTH - 96, y: GAME_HEIGHT - 96 },
  { x: GAME_WIDTH - 96, y: 96 },
  { x: 96, y: GAME_HEIGHT - 96 }
];

export function createObstacles(): Obstacle[] {
  return [
    { id: "o1", x: 250, y: 180, width: 120, height: 30 },
    { id: "o2", x: 590, y: 180, width: 120, height: 30 },
    { id: "o3", x: 430, y: 300, width: 100, height: 40 },
    { id: "o4", x: 240, y: 470, width: 140, height: 30 },
    { id: "o5", x: 580, y: 470, width: 140, height: 30 }
  ];
}

export function createEmptyInput(): PlayerInputState {
  return {
    forward: false,
    backward: false,
    rotateLeft: false,
    rotateRight: false,
    turretLeft: false,
    turretRight: false,
    fire: false,
    seq: 0
  };
}

export function createPlayerState(id: string, nickname: string, index: number): PlayerState {
  const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
  return {
    id,
    nickname,
    connected: true,
    ready: false,
    alive: true,
    hp: MAX_HP,
    position: { ...spawn },
    bodyRotation: 0,
    turretRotation: 0,
    lastProcessedSeq: 0
  };
}

export function createInitialGameState(roomCode: string): ServerGameState {
  return {
    roomCode,
    phase: "lobby",
    tick: 0,
    roundEndsAt: null,
    players: {},
    bullets: [],
    obstacles: createObstacles(),
    winnerId: null
  };
}

export function startMatch(state: ServerGameState, startedAt: number): void {
  state.phase = "playing";
  state.tick = 0;
  state.bullets = [];
  state.roundEndsAt = startedAt + ROUND_DURATION_MS;
  state.winnerId = null;

  Object.values(state.players).forEach((playerRecord, index) => {
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length];
    playerRecord.state.position = { ...spawn };
    playerRecord.state.bodyRotation = 0;
    playerRecord.state.turretRotation = 0;
    playerRecord.state.hp = MAX_HP;
    playerRecord.state.alive = playerRecord.state.connected;
    playerRecord.lastShotAt = 0;
    playerRecord.input = createEmptyInput();
  });
}

export function createSnapshot(state: ServerGameState): GameSnapshot {
  return {
    roomCode: state.roomCode,
    phase: state.phase,
    tick: state.tick,
    roundEndsAt: state.roundEndsAt,
    players: Object.values(state.players).map((record) => ({ ...record.state, position: { ...record.state.position } })),
    bullets: state.bullets.map((bullet) => ({
      ...bullet,
      position: { ...bullet.position },
      velocity: { ...bullet.velocity }
    })),
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    winnerId: state.winnerId
  };
}

function clampPosition(position: Vec2): Vec2 {
  return {
    x: Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, position.x)),
    y: Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, position.y))
  };
}

function collidesObstacleCircle(position: Vec2, radius: number, obstacle: Obstacle): boolean {
  const nearestX = Math.max(obstacle.x, Math.min(position.x, obstacle.x + obstacle.width));
  const nearestY = Math.max(obstacle.y, Math.min(position.y, obstacle.y + obstacle.height));
  const dx = position.x - nearestX;
  const dy = position.y - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function collidesObstacle(position: Vec2, obstacles: Obstacle[]): boolean {
  return obstacles.some((obstacle) => collidesObstacleCircle(position, PLAYER_RADIUS, obstacle));
}

function tryMovePlayer(record: ServerPlayerRecord, dtSeconds: number, obstacles: Obstacle[]): void {
  const input = record.input;
  const bodyTurn = Number(input.rotateRight) - Number(input.rotateLeft);
  const turretTurn = Number(input.turretRight) - Number(input.turretLeft);
  const throttle = Number(input.forward) - Number(input.backward);

  record.state.bodyRotation += bodyTurn * BODY_ROTATION_SPEED * dtSeconds;
  record.state.turretRotation += turretTurn * TURRET_ROTATION_SPEED * dtSeconds;

  if (throttle === 0) {
    return;
  }

  const velocity = {
    x: Math.cos(record.state.bodyRotation) * PLAYER_SPEED * throttle * dtSeconds,
    y: Math.sin(record.state.bodyRotation) * PLAYER_SPEED * throttle * dtSeconds
  };

  const target = clampPosition({
    x: record.state.position.x + velocity.x,
    y: record.state.position.y + velocity.y
  });

  if (!collidesObstacle(target, obstacles)) {
    record.state.position = target;
  }
}

function spawnBullet(record: ServerPlayerRecord, now: number): BulletState | null {
  if (!record.state.alive) {
    return null;
  }

  if (now - record.lastShotAt < FIRE_COOLDOWN_MS) {
    return null;
  }

  record.lastShotAt = now;
  const angle = record.state.turretRotation;
  return {
    id: `${record.state.id}-${now}-${record.input.seq}`,
    ownerId: record.state.id,
    position: {
      x: record.state.position.x + Math.cos(angle) * (PLAYER_RADIUS + 6),
      y: record.state.position.y + Math.sin(angle) * (PLAYER_RADIUS + 6)
    },
    velocity: {
      x: Math.cos(angle) * BULLET_SPEED,
      y: Math.sin(angle) * BULLET_SPEED
    }
  };
}

function playerHit(player: PlayerState, bullet: BulletState): boolean {
  if (!player.alive || player.id === bullet.ownerId) {
    return false;
  }

  const dx = player.position.x - bullet.position.x;
  const dy = player.position.y - bullet.position.y;
  return dx * dx + dy * dy <= (PLAYER_RADIUS + BULLET_RADIUS) * (PLAYER_RADIUS + BULLET_RADIUS);
}

export interface TickOutcome {
  damaged: Array<{ playerId: string; hp: number }>;
  eliminated: string[];
  winnerId: string | null;
  endedReason: "winner" | "timeout" | null;
}

export function stepGame(state: ServerGameState, dtMs: number, now: number): TickOutcome {
  state.tick += 1;
  const dtSeconds = dtMs / 1000;
  const outcome: TickOutcome = {
    damaged: [],
    eliminated: [],
    winnerId: null,
    endedReason: null
  };

  Object.values(state.players).forEach((record) => {
    if (!record.state.connected || !record.state.alive) {
      return;
    }

    record.state.lastProcessedSeq = record.input.seq;
    tryMovePlayer(record, dtSeconds, state.obstacles);

    if (record.input.fire) {
      const bullet = spawnBullet(record, now);
      if (bullet) {
        state.bullets.push(bullet);
      }
    }
  });

  const nextBullets: BulletState[] = [];
  for (const bullet of state.bullets) {
    bullet.position.x += bullet.velocity.x * dtSeconds;
    bullet.position.y += bullet.velocity.y * dtSeconds;

    const inBounds =
      bullet.position.x >= 0 &&
      bullet.position.x <= GAME_WIDTH &&
      bullet.position.y >= 0 &&
      bullet.position.y <= GAME_HEIGHT;

    if (!inBounds) {
      continue;
    }

    const obstacleHit = state.obstacles.some((obstacle) =>
      collidesObstacleCircle(bullet.position, BULLET_RADIUS, obstacle)
    );
    if (obstacleHit) {
      continue;
    }

    let consumed = false;
    for (const playerRecord of Object.values(state.players)) {
      const player = playerRecord.state;
      if (!playerHit(player, bullet)) {
        continue;
      }

      consumed = true;
      player.hp -= 1;
      outcome.damaged.push({ playerId: player.id, hp: player.hp });
      if (player.hp <= 0) {
        player.hp = 0;
        player.alive = false;
        outcome.eliminated.push(player.id);
      }
      break;
    }

    if (!consumed) {
      nextBullets.push(bullet);
    }
  }
  state.bullets = nextBullets;

  const alivePlayers = Object.values(state.players).filter((record) => record.state.connected && record.state.alive);
  if (alivePlayers.length <= 1) {
    state.phase = "finished";
    state.winnerId = alivePlayers[0]?.state.id ?? null;
    outcome.winnerId = state.winnerId;
    outcome.endedReason = "winner";
    return outcome;
  }

  if (state.roundEndsAt !== null && now >= state.roundEndsAt) {
    state.phase = "finished";
    const players = Object.values(state.players)
      .filter((record) => record.state.connected)
      .map((record) => record.state);
    const maxHp = Math.max(...players.map((player) => player.hp));
    const leaders = players.filter((player) => player.hp === maxHp);
    state.winnerId = leaders.length === 1 ? leaders[0].id : null;
    outcome.winnerId = state.winnerId;
    outcome.endedReason = "timeout";
  }

  return outcome;
}
