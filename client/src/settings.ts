// /set labels accepted by the server (crates/sim/src/settings.rs `set`), mapped
// to the GameSettings field they write. The server lowercases the label, so
// the label is what we send as `set_setting.key`.

export type SettingKind = "f" | "i" | "b";

export interface SettingDef {
  label: string;
  name: string;
  field: string;
  kind: SettingKind;
  group: string;
}

export const SETTINGS: SettingDef[] = [
  { label: "timeScale", name: "Time scale", field: "time_scale", kind: "f", group: "General" },
  { label: "gravityOffset", name: "Gravity offset", field: "gravity_offset", kind: "f", group: "General" },
  { label: "pushPlayers", name: "Push players", field: "push_players", kind: "b", group: "Push" },
  { label: "pushRange", name: "Push range", field: "push_range", kind: "f", group: "Push" },
  { label: "pushDelay", name: "Push delay", field: "push_delay", kind: "i", group: "Push" },
  { label: "maxStamina", name: "Max stamina", field: "max_stamina", kind: "f", group: "Push" },
  { label: "pushminammotostartpush", name: "Ammo to start a push", field: "push_min_ammo", kind: "f", group: "Push" },
  { label: "pushammospendifpushing", name: "Ammo spent while pushing", field: "push_spend", kind: "f", group: "Push" },
  { label: "pushammospendatfirstpushframe", name: "Ammo spent on first push", field: "push_first_spend", kind: "f", group: "Push" },
  { label: "pushammoreplenish", name: "Ammo regen", field: "ammo_regen", kind: "f", group: "Push" },
  { label: "bbPower", name: "Bat power", field: "bat_power", kind: "f", group: "Bat" },
  { label: "bbRange", name: "Bat range", field: "bat_range", kind: "f", group: "Bat" },
  { label: "bbAngleVariance", name: "Bat angle variance", field: "bat_angle", kind: "f", group: "Bat" },
  { label: "bbFireOn", name: "Bat fire on", field: "bat_fire_on", kind: "f", group: "Bat" },
  { label: "bbFireFramesLength", name: "Bat fire frames", field: "bat_fire_frames", kind: "f", group: "Bat" },
  { label: "bbHideAfterFireFrames", name: "Bat hide after fire", field: "bat_hide_after", kind: "f", group: "Bat" },
  { label: "bbResetOn", name: "Bat reset on", field: "bat_reset_on", kind: "f", group: "Bat" },
  { label: "bbEnabled", name: "Bat enabled", field: "bat_enabled", kind: "b", group: "Bat" },
  { label: "bbHoldUntil", name: "Bat hold until", field: "bat_hold_until", kind: "f", group: "Bat" },
  { label: "bbInitAmmoCost", name: "Bat start ammo cost", field: "bat_init_cost", kind: "f", group: "Bat" },
  { label: "bbHoldAmmoCost", name: "Bat hold ammo cost", field: "bat_hold_cost", kind: "f", group: "Bat" },
  { label: "dashInitDelay", name: "Dash start delay", field: "dash_init_delay", kind: "i", group: "Dash" },
  { label: "dashActiveLength", name: "Dash length", field: "dash_active", kind: "i", group: "Dash" },
  { label: "dashCoolDownAfterLength", name: "Dash cooldown", field: "dash_cooldown", kind: "i", group: "Dash" },
  { label: "dashBoostSpeed", name: "Dash speed", field: "dash_boost", kind: "i", group: "Dash" },
  { label: "dashAmmoCost", name: "Dash ammo cost", field: "dash_cost", kind: "i", group: "Dash" },
  { label: "dashEnabled", name: "Dash enabled", field: "dash_enabled", kind: "b", group: "Dash" },
  { label: "parachuteEnabled", name: "Parachute enabled", field: "parachute_enabled", kind: "b", group: "Parachute" },
  { label: "rkAmmoNeeded", name: "Rocket ammo needed", field: "rocket_cost", kind: "f", group: "Rocket" },
  { label: "rkVelocity", name: "Rocket speed", field: "rocket_speed", kind: "f", group: "Rocket" },
  { label: "rkAimRate", name: "Rocket aim rate", field: "rocket_aim_rate", kind: "f", group: "Rocket" },
  { label: "rkBulletRound", name: "Rocket round", field: "rocket_round", kind: "b", group: "Rocket" },
  { label: "rkBulletRadius", name: "Rocket radius", field: "rocket_radius", kind: "f", group: "Rocket" },
  { label: "rkBulletAge", name: "Rocket lifetime", field: "rocket_age", kind: "f", group: "Rocket" },
  { label: "rkBulletTurnRate", name: "Rocket turn rate", field: "rocket_turn_rate", kind: "f", group: "Rocket" },
  { label: "rkBulletGravityScale", name: "Rocket gravity", field: "rocket_gravity_scale", kind: "f", group: "Rocket" },
  { label: "rkBulletBounces", name: "Rocket bounces", field: "rocket_bounces", kind: "b", group: "Rocket" },
  { label: "rkBulletRestitution", name: "Rocket bounciness", field: "rocket_restitution", kind: "f", group: "Rocket" },
  { label: "rkBulletBounceCountLimit", name: "Rocket bounce limit", field: "rocket_bounce_limit", kind: "f", group: "Rocket" },
  { label: "rkSelfBatScale", name: "Rocket self-hit bat scale", field: "rocket_self_bat_scale", kind: "f", group: "Rocket" },
  { label: "rkExplodeRadius", name: "Rocket blast radius", field: "rocket_explode_radius", kind: "f", group: "Rocket" },
  { label: "rkExplodePush", name: "Rocket blast push", field: "rocket_explode_push", kind: "f", group: "Rocket" },
  { label: "egEnabled", name: "Egg enabled", field: "egg_enabled", kind: "b", group: "Egg" },
  { label: "egSize", name: "Egg size", field: "egg_size", kind: "f", group: "Egg" },
  { label: "egAge", name: "Egg lifetime", field: "egg_age", kind: "f", group: "Egg" },
  { label: "egGravityScale", name: "Egg gravity", field: "egg_gravity_scale", kind: "f", group: "Egg" },
  { label: "egRestitution", name: "Egg bounciness", field: "egg_restitution", kind: "f", group: "Egg" },
  { label: "egExplodeRadius", name: "Egg blast radius", field: "egg_explode_radius", kind: "f", group: "Egg" },
  { label: "egStartSpin", name: "Egg start spin", field: "egg_spin", kind: "f", group: "Egg" },
  { label: "egMaxThrowPower", name: "Egg max throw power", field: "egg_power", kind: "f", group: "Egg" },
  { label: "egAmmoNeeded", name: "Egg ammo needed", field: "egg_cost", kind: "f", group: "Egg" },
  { label: "egDelay1", name: "Egg delay 1", field: "egg_delay1", kind: "i", group: "Egg" },
  { label: "egDelay2", name: "Egg delay 2", field: "egg_delay2", kind: "i", group: "Egg" },
  { label: "egDelayBeforeAmmoUse", name: "Egg delay before ammo use", field: "egg_delay_ammo", kind: "i", group: "Egg" },
  { label: "egAimRate", name: "Egg aim rate", field: "egg_aim_rate", kind: "f", group: "Egg" },
  { label: "egShape", name: "Egg shape", field: "egg_shape", kind: "i", group: "Egg" },
  { label: "playerSize", name: "Player width", field: "player_width", kind: "f", group: "Player" },
  { label: "objectiveLimit", name: "Score to win", field: "objective_limit", kind: "i", group: "Match" },
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

/** A player-facing label for a read-only setting key: sentence case, underscores as spaces. */
export function readOnlyLabel(key: string): string {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
