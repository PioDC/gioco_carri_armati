export type RoomPhase = "lobby" | "playing" | "finished";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerInputState {
  forward: boolean;
  backward: boolean;
  rotateLeft: boolean;
  rotateRight: boolean;
  turretLeft: boolean;
  turretRight: boolean;
  fire: boolean;
  seq: number;
}

export interface PlayerState {
  id: string;
  nickname: string;
  connected: boolean;
  ready: boolean;
  alive: boolean;
  hp: number;
  position: Vec2;
  bodyRotation: number;
  turretRotation: number;
  lastProcessedSeq: number;
}

export interface BulletState {
  id: string;
  ownerId: string;
  position: Vec2;
  velocity: Vec2;
}

export interface GameSnapshot {
  roomCode: string;
  phase: RoomPhase;
  tick: number;
  roundEndsAt: number | null;
  players: PlayerState[];
  bullets: BulletState[];
  obstacles: Obstacle[];
  winnerId: string | null;
}

export interface LobbyPlayer {
  id: string;
  nickname: string;
  ready: boolean;
  connected: boolean;
}

export interface LobbyState {
  roomCode: string;
  phase: RoomPhase;
  players: LobbyPlayer[];
  hostId: string | null;
}

export interface CreateRoomResponse {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

export interface JoinRoomRequest {
  nickname: string;
}

export interface JoinRoomResponse extends CreateRoomResponse {}

export type ClientMessage =
  | { type: "ready"; ready: boolean }
  | { type: "input"; input: PlayerInputState }
  | { type: "ping"; timestamp: number };

export type ServerMessage =
  | { type: "lobby_state"; lobby: LobbyState }
  | { type: "match_start"; snapshot: GameSnapshot }
  | { type: "state_snapshot"; snapshot: GameSnapshot }
  | { type: "player_damaged"; playerId: string; hp: number }
  | { type: "player_eliminated"; playerId: string }
  | { type: "match_end"; snapshot: GameSnapshot; reason: "winner" | "timeout" | "abandon" }
  | { type: "error"; message: string }
  | { type: "pong"; timestamp: number };
