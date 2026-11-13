// /set labels accepted by the server (crates/sim/src/settings.rs `set`), mapped
// to the GameSettings field they write. The server lowercases the label, so
// the label is what we send as `set_setting.key`.

export type SettingKind = "f" | "i" | "b";

export interface SettingDef {
  label: string;
  field: string;
  kind: SettingKind;
  group: string;
}

export const SETTINGS: SettingDef[] = [
  { label: "timeScale", field: "time_scale", kind: "f", group: "General" },
  { label: "gravityOffset", field: "gravity_offset", kind: "f", group: "General" },
  { label: "pushPlayers", field: "push_players", kind: "b", group: "Push" },
  { label: "pushRange", field: "push_range", kind: "f", group: "Push" },
  { label: "pushDelay", field: "push_delay", kind: "i", group: "Push" },
  { label: "maxStamina", field: "max_stamina", kind: "f", group: "Push" },
  { label: "pushminammotostartpush", field: "push_min_ammo", kind: "f", group: "Push" },
  { label: "pushammospendifpushing", field: "push_spend", kind: "f", group: "Push" },
  { label: "pushammospendatfirstpushframe", field: "push_first_spend", kind: "f", group: "Push" },
  { label: "pushammoreplenish", field: "ammo_regen", kind: "f", group: "Push" },
  { label: "bbPower", field: "bat_power", kind: "f", group: "Bat" },
  { label: "bbRange", field: "bat_range", kind: "f", group: "Bat" },
  { label: "bbAngleVariance", field: "bat_angle", kind: "f", group: "Bat" },
  { label: "bbFireOn", field: "bat_fire_on", kind: "f", group: "Bat" },
  { label: "bbFireFramesLength", field: "bat_fire_frames", kind: "f", group: "Bat" },
  { label: "bbHideAfterFireFrames", field: "bat_hide_after", kind: "f", group: "Bat" },
  { label: "bbResetOn", field: "bat_reset_on", kind: "f", group: "Bat" },
  { label: "bbEnabled", field: "bat_enabled", kind: "b", group: "Bat" },
  { label: "bbHoldUntil", field: "bat_hold_until", kind: "f", group: "Bat" },
  { label: "bbInitAmmoCost", field: "bat_init_cost", kind: "f", group: "Bat" },
  { label: "bbHoldAmmoCost", field: "bat_hold_cost", kind: "f", group: "Bat" },
  { label: "dashInitDelay", field: "dash_init_delay", kind: "i", group: "Dash" },
  { label: "dashActiveLength", field: "dash_active", kind: "i", group: "Dash" },
  { label: "dashCoolDownAfterLength", field: "dash_cooldown", kind: "i", group: "Dash" },
  { label: "dashBoostSpeed", field: "dash_boost", kind: "i", group: "Dash" },
  { label: "dashAmmoCost", field: "dash_cost", kind: "i", group: "Dash" },
  { label: "dashEnabled", field: "dash_enabled", kind: "b", group: "Dash" },
  { label: "parachuteEnabled", field: "parachute_enabled", kind: "b", group: "Parachute" },
  { label: "rkAmmoNeeded", field: "rocket_cost", kind: "f", group: "Rocket" },
  { label: "rkVelocity", field: "rocket_speed", kind: "f", group: "Rocket" },
  { label: "rkAimRate", field: "rocket_aim_rate", kind: "f", group: "Rocket" },
  { label: "rkBulletRound", field: "rocket_round", kind: "b", group: "Rocket" },
  { label: "rkBulletRadius", field: "rocket_radius", kind: "f", group: "Rocket" },
  { label: "rkBulletAge", field: "rocket_age", kind: "f", group: "Rocket" },
  { label: "rkBulletTurnRate", field: "rocket_turn_rate", kind: "f", group: "Rocket" },
  { label: "rkBulletGravityScale", field: "rocket_gravity_scale", kind: "f", group: "Rocket" },
  { label: "rkBulletBounces", field: "rocket_bounces", kind: "b", group: "Rocket" },
  { label: "rkBulletRestitution", field: "rocket_restitution", kind: "f", group: "Rocket" },
  { label: "rkBulletBounceCountLimit", field: "rocket_bounce_limit", kind: "f", group: "Rocket" },
  { label: "rkSelfBatScale", field: "rocket_self_bat_scale", kind: "f", group: "Rocket" },
  { label: "rkExplodeRadius", field: "rocket_explode_radius", kind: "f", group: "Rocket" },
  { label: "rkExplodePush", field: "rocket_explode_push", kind: "f", group: "Rocket" },
  { label: "egEnabled", field: "egg_enabled", kind: "b", group: "Egg" },
  { label: "egSize", field: "egg_size", kind: "f", group: "Egg" },
  { label: "egAge", field: "egg_age", kind: "f", group: "Egg" },
  { label: "egGravityScale", field: "egg_gravity_scale", kind: "f", group: "Egg" },
  { label: "egRestitution", field: "egg_restitution", kind: "f", group: "Egg" },
  { label: "egExplodeRadius", field: "egg_explode_radius", kind: "f", group: "Egg" },
  { label: "egStartSpin", field: "egg_spin", kind: "f", group: "Egg" },
  { label: "egMaxThrowPower", field: "egg_power", kind: "f", group: "Egg" },
  { label: "egAmmoNeeded", field: "egg_cost", kind: "f", group: "Egg" },
  { label: "egDelay1", field: "egg_delay1", kind: "i", group: "Egg" },
  { label: "egDelay2", field: "egg_delay2", kind: "i", group: "Egg" },
  { label: "egDelayBeforeAmmoUse", field: "egg_delay_ammo", kind: "i", group: "Egg" },
  { label: "egAimRate", field: "egg_aim_rate", kind: "f", group: "Egg" },
  { label: "egShape", field: "egg_shape", kind: "i", group: "Egg" },
  { label: "playerSize", field: "player_width", kind: "f", group: "Player" },
  { label: "objectiveLimit", field: "objective_limit", kind: "i", group: "Match" },
];

/** Keys handled elsewhere (game mode control) or covered by a label above. */
const COVERED = new Set<string>([
  "game_mode",
  "player_height",
  ...SETTINGS.map((s) => s.field),
]);

/** Settings shown read-only: everything the server does not accept via /set. */
export function readOnlyKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).filter((k) => !COVERED.has(k)).sort();
}

export function formatValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  return String(v);
}

/** Parse a user-typed value the way the server does (booleans are "true" only). */
export function normalizeInput(kind: SettingKind, raw: string): string {
  const s = raw.trim();
  if (kind === "b") return s === "true" ? "true" : "false";
  return s;
}
