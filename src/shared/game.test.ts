import { describe, expect, it } from "vitest";
import { FIRE_COOLDOWN_MS, MAX_HP } from "./constants";
import {
  createEmptyInput,
  createInitialGameState,
  createPlayerState,
  startMatch,
  stepGame
} from "./game";

function addPlayer(state: ReturnType<typeof createInitialGameState>, id: string, nickname: string, index: number) {
  state.players[id] = {
    state: createPlayerState(id, nickname, index),
    input: createEmptyInput(),
    lastShotAt: 0
  };
}

describe("shared game loop", () => {
  it("eliminates a tank after four hits", () => {
    const state = createInitialGameState("ROOM1");
    addPlayer(state, "p1", "One", 0);
    addPlayer(state, "p2", "Two", 1);
    startMatch(state, 0);

    const shooter = state.players.p1;
    const target = state.players.p2;
    shooter.state.position = { x: 200, y: 200 };
    shooter.state.turretRotation = 0;
    target.state.position = { x: 240, y: 200 };

    let now = FIRE_COOLDOWN_MS + 1;
    for (let hit = 1; hit <= MAX_HP; hit += 1) {
      shooter.input = {
        ...createEmptyInput(),
        fire: true,
        seq: hit
      };
      const outcome = stepGame(state, 50, now);
      expect(outcome.damaged.at(-1)?.playerId).toBe("p2");
      expect(target.state.hp).toBe(MAX_HP - hit);
      now += FIRE_COOLDOWN_MS + 1;
    }

    expect(target.state.alive).toBe(false);
    expect(state.phase).toBe("finished");
    expect(state.winnerId).toBe("p1");
  });

  it("moves and rotates with tank controls", () => {
    const state = createInitialGameState("ROOM1");
    addPlayer(state, "p1", "One", 0);
    addPlayer(state, "p2", "Two", 1);
    startMatch(state, 0);

    const player = state.players.p1;
    const initial = { ...player.state.position };
    player.input = {
      ...createEmptyInput(),
      forward: true,
      rotateRight: true,
      turretRight: true,
      seq: 1
    };

    stepGame(state, 500, 1000);
    const traveled = Math.hypot(player.state.position.x - initial.x, player.state.position.y - initial.y);
    expect(traveled).toBeGreaterThan(20);
    expect(player.state.bodyRotation).toBeGreaterThan(0.5);
    expect(player.state.turretRotation).toBeGreaterThan(0.5);
  });
});
