# Original names

One reference table for names the original Hitbox/heav.io client and sim used, and where neobox names them now. Each section covers one area; sections append in place.

Bundle date/build: no build of the original bundle is recorded in this repo, so the column is "unknown" unless a row says otherwise.

## Client (map editor)

The editor code at HEAD used no minified identifiers. Its "original bundle name" column is the raw map key the original writer put in the map file. Those keys are kept byte-for-byte for Hitbox map compatibility and are defined only in `client/src/editor/schema.ts`. Keys are listed per entity; the same number means a different field on each entity.

| Original bundle name | Bundle build | Meaning | Neobox name (client/src/editor/schema.ts) |
|---|---|---|---|
| `"b"` | unknown | body list | `MAP.bodies` |
| `"j"` | unknown | joint list | `MAP.joints` |
| `"s"` | unknown | spawn list | `MAP.spawns` |
| `"tu"` | unknown | turret list | `MAP.turrets` |
| `"gp"` | unknown | grapple list | `MAP.grapples` |
| `"c"` | unknown | capture-point list | `MAP.caps` |
| `"set"` | unknown | map settings object | `MAP.settings` |
| `"1"`..`"65"` (body) | unknown | body fields; see the body keys below | `BODY.*` |
| `"s"` (body) | unknown | body shapes array | `BODY.shapes` |
| `"1"`..`"15"` (shape) | unknown | shape kind, offset, material overrides, colour, closed, radius, editor fields, no-physics, z index | `SHAPE.*` |
| `"p"` (shape) | unknown | polygon vertices, flat array | `SHAPE.points` |
| `"1"`..`"19"` (joint) | unknown | joint anchors, kind, collide-connected, body ids, spring and motor fields, player override, motor mode, latch, slider axis | `JOINT.*` |
| `"1"`..`"8"` (spawn) | unknown | position, priority, angle, team flags, capture sequence | `SPAWN.*` |
| `"1"`..`"24"` (turret) | unknown | position, velocity, angle, health, cooldown, team, fire interval, range; keys 12-23 the bullet; 24 max health | `TURRET.*` |
| `"1"`..`"4"` (grapple) | unknown | position, range, attached body id | `GRAPPLE.*` |
| `"1"`, `"2"` (spawn, turret, grapple, cap) | unknown | anchored marker position | `MARKER.x`, `MARKER.y` |
| `"1"`..`"8"` (cap) | unknown | position, width, sequence, owner, capturer, capture time, progress | `CAP.*` |
| `"3"`..`"19"` (settings) | unknown | screen width, snap, background, parallax, colours, arena size, gravity, wrap | `SETTINGS.*` |
| `"aspect"` (settings) | neobox key | `"wide"` selects the 16:9 view; not a numeric key | `SETTINGS.aspect` |

Body keys (`BODY.*`): `"1"` id, `"2"` x, `"3"` y, `"4"` angle, `"5"` start spin (rad/s), `"6"` start velocity x, `"7"` start velocity y, `"8"` density, `"9"` restitution, `"10"` friction, `"11"` linear damping, `"12"` angular damping, `"13"` kills players, `"14"` motion (0 static, 1 kinematic, 2 dynamic), `"15"` wrap, `"16"` sim field with no editor meaning (`flag16`), `"17"` force x, `"18"` force y, `"19"` torque, `"20"` damage, `"21"` dynamic threshold, `"22"` removal threshold, `"23"` scenery (no physics), `"24"` z index, `"25"` collision group a to d, `"26"`-`"29"` collide A to D, `"30"` player pass, `"31"` checkpoint, `"32"` freeze players, `"34"` race object, `"36"` pinned, `"37"` pin x, `"38"` pin y, `"39"` force zone, `"40"` zone x, `"41"` zone y, `"43"` no jump, `"44"` race progress, `"45"` continuous collision, `"50"` invisible, `"55"` parallax, `"56"` lifetime, `"57"` fixed rotation, `"58"` source player, `"60"` ability immune, `"61"` objective, `"62"` objective target, `"63"` sim field with no editor meaning (`flag63`), `"64"` impact-sound limiter state, `"65"` projectile pass.

Shape keys (`SHAPE.*`): `"1"` kind (0 polygon, 1 circle), `"2"` x, `"3"` y, `"4"` density override, `"5"` friction override, `"6"` restitution override, `"7"` colour 0xRRGGBB, `"8"` closed, `"9"` radius, `"11"`-`"13"` editor fields, `"14"` no physics, `"15"` z index, `"p"` vertices.

Joint keys (`JOINT.*`): `"1"`/`"2"` anchor A x/y, `"3"`/`"4"` anchor B x/y, `"5"` kind (0 spring, 1 pivot, 2 slider), `"6"` collide connected, `"7"`/`"8"` body A/B id (-1 ground), `"9"` frequency, `"10"` damping, `"11"` length, `"12"` motor speed, `"13"` max motor, `"14"` player overriding body A (-1 none), `"15"` sim field with no editor meaning (`flag15`), `"16"` motor mode (0 none, 1 stop, 2 ping-pong, 3 latch), `"17"` latched, `"18"`/`"19"` slider axis end x/y (body A local).

Spawn keys (`SPAWN.*`): `"1"` x, `"2"` y, `"3"` priority, `"4"` angle, `"5"`-`"7"` team flags (free for all, red, blue), `"8"` capture sequence (-2 none).

Turret keys (`TURRET.*`): `"1"` x, `"2"` y, `"3"` vx, `"4"` vy, `"5"` angle, `"6"` angular velocity, `"7"` health, `"8"` cooldown, `"9"` team, `"10"` fire interval, `"11"` range, `"12"` bullet vx, `"13"` bullet size, `"14"` bullet density, `"15"` bullet friction, `"16"` bullet restitution, `"17"` bullet life, `"18"` bullet damage, `"19"` bullet turn rate, `"20"` bullet explode radius, `"21"` bullet bounces, `"22"` bullet shape, `"23"` bullet linear damping, `"24"` max health.

Grapple keys (`GRAPPLE.*`): `"1"` x, `"2"` y, `"3"` range, `"4"` attached body id (-1 world).

Cap keys (`CAP.*`): `"1"` x, `"2"` y, `"3"` width, `"4"` sequence (-1 none), `"5"` owner team, `"6"` team capturing, `"7"` capture time, `"8"` progress.

Settings keys (`SETTINGS.*`): `"3"` screen width, `"4"` snap, `"5"` unused enum kept for round-trips, `"7"`/`"8"` background offset x/y, `"9"` background image, `"10"` background scale, `"11"` parallax, `"12"` top colour, `"13"` sim flag with no editor meaning (`flag13`), `"15"`/`"16"` arena width/height, `"17"` bottom colour, `"18"` gravity, `"19"` wrap.

## Rust simulation (crates/sim)

Names below are the Rust identifiers. The map key constants are in `crates/sim/src/map_keys.rs`; the raw key strings live only there. Map fields with no known meaning are `unknown_<key>`; the value is still read and written.

### Persisted state (state.rs)

Postcard state is positional: these renames change names only, never field order or types.

| Struct | Former name | New name | Meaning |
|---|---|---|---|
| `PlayerRecord` | `co` | `best_finish_time` | best finish time this match |
| `PlayerRecord` | `do_` | `checkpoint_age` | age at the last tick, while the map has checkpoints |
| `PlayerRecord` | `po` | `last_finish_time` | last finish time |
| `PlayerRecord` | `wo` | `best_checkpoint_times` | checkpoint times of the best run |
| `PlayerRecord` | `mo` | `checkpoint_times` | checkpoint times of the current run |
| `PlayerRecord` | `yo` | `checkpoint_delta` | time behind (+) or ahead of (-) the best run |
| `PlayerRecord` | `fo` | `last_checkpoint_time` | time of the last checkpoint |
| `Round` | `io` | `map_index` | index of the current map in the rotation playlist |
| `Round` | `lo` | `rotation` | next map is played after a game over |
| `Round` | `po` | `reserved_2` | kept for layout; no rule reads it |
| `Round` | `bo` | `reserved_0` | kept for layout; no rule reads it |
| `Attach` | `de` | `reserved` | kept for layout; no rule reads it |
| `Player` | `tn` | `reserved_flag` | kept for layout; no rule reads it |
| `Player` | `en` | `reset_count` | compared against the race reset limit |
| `Player` | `kn` | `reserved_count` | kept for layout; no rule reads it |
| `Player` | `sn2` | `reserved_count_2` | kept for layout; no rule reads it |
| `Player` | `nn2` | `reserved_flag_2` | kept for layout; no rule reads it |
| `Body` | `ye` | `teleported` | teleported this tick |
| `Body` | `ya` | `damage` | accumulated damage |
| `Body` | `ba` | `lifetime` | lifetime countdown (-1 none) |
| `Body` | `va` | `sound_limiter` | impact-sound limiter |
| `Body` | `ka` | `push_from` | push attribution: player id to weight |
| `PickupRow` (was `PuRow`) | `yu` | `reserved` | kept for layout; nothing reads it |
| `State` | `pu` | `pickups` | pickup bucket (was `PuRow`, now `PickupRow`) |
| `Counters` | `pu` | `pickups` | pickup counter |
| `Effect` | `ln` | `extra_value` | unknown; renamed only |

### Map format (map.rs, map_keys.rs)

| Struct | Former name | New name | Key |
|---|---|---|---|
| `MapSettings` | `gn` | `unknown_5` | `"5"` |
| `MapSettings` | `qn` | `unknown_13` | `"13"` |
| `MapShape` | `aa` / `la` / `ua` | `unknown_11` / `unknown_12` / `unknown_13` | `"11"` / `"12"` / `"13"` |
| `BodyDef` | `ea` | `unknown_63` | `"63"` |
| `MapJoint` | `ha` | `unknown_15` | `"15"` (sim flag, no editor meaning) |
| `MapBody` | `ye` | `teleported` | sim field |
| `MapBody` | `va` | `sound_limiter` | sim field |

Map key strings are constants in `map_keys.rs`, grouped by object (`root`, `settings`, `shape`, `body`, `joint`, `spawn`, `turret`, `grapple`, `cap`). Byte values are unchanged.

### Wrappers and flags (objects.rs, player.rs, round.rs, race.rs, step.rs)

| Type | Former name | New name | Meaning |
|---|---|---|---|
| every wrapper (`BodyObj`, `JointObj`, `ProjObj`, `TurretObj`, `CapObj`, `PickupObj`, `PlayerObj`, `RoundObj`) | `eo` | `row` | the state row the wrapper owns |
| `PlayerObj` | `hs` | `sort_half_width` | half width used to sort candidates |
| `PlayerObj` | `hu` | `half_width` | player half width |
| `PlayerObj` | `eu` | `half_height` | player half height |
| `PlayerObj` | `xl` | `debris_up` | debris-up flag |
| `PlayerObj` | `su` | `special_held` | special key held |
| `PlayerObj` | `gone` | `leaving` | player is leaving |
| `PlayerObj` | `dead` | `died` | player died this tick |
| `Player` (method) | `gn_set` | `set_rocket_aim` | sets the rocket aim angle |
| `GameSettings` | `w` (serde key `"w"`) | `flag_w` | original key `W`; no known meaning, never read |

### Settings (settings.rs)

Field names are unchanged (`time_scale`, `bat_power`, ...). `/set` and `/settings` use the camelCase names below. The doc comments used to lead with the original's one- or two-letter key; those keys are listed here for reference.

| Original key | Name |
|---|---|
| `J` | `timeScale` |
| `G` | `gravityOffset` |
| `H` | `gameMode` |
| `Y` | `pushPlayers` |
| `q` | `pushRange` |
| `V` | `pushDelay` |
| `K` | `maxStamina` |
| `X` | `pushMinAmmoToStartPush` |
| `Z` | `pushAmmoSpendIfPushing` |
| `$` | `pushAmmoSpendAtFirstPushFrame` |
| `tt` | `pushAmmoReplenish` |
| `it` / `st` / `ht` / `et` / `nt` / `ot` / `rt` / `at` / `lt` / `ut` / `ct` | `bbPower` / `bbRange` / `bbAngleVariance` / `bbHoldUntil` / `bbFireOn` / `bbInitAmmoCost` / `bbHoldAmmoCost` / `bbFireFramesLength` / `bbHideAfterFireFrames` / `bbResetOn` / `bbEnabled` |
| `dt` / `wt` / `ft` / `gt` / `yt` / `bt` / `vt` | `dashInitDelay` / `dashActiveLength` / `dashCoolDownAfterLength` / `dashBoostSpeed` / `dashAmmoCost` / `dashEnabled` / `parachuteEnabled` |
| `kt` / `St` / `Nt` / `Mt` / `Ct` / `Tt` / `xt` / `_t` / `Pt` / `Et` / `Bt` / `It` / `Ft` / `At` | `rkAmmoNeeded` / `rkVelocity` / `rkAimRate` / `rkBulletRound` / `rkBulletRadius` / `rkBulletAge` / `rkBulletTurnRate` / `rkBulletGravityScale` / `rkBulletBounces` / `rkBulletRestitution` / `rkBulletBounceCountLimit` / `rkSelfBatScale` / `rkExplodeRadius` / `rkExplodePush` |
| `Ot` / `Rt` / `Dt` / `Lt` / `Ut` / `jt` / `Wt` / `Jt` / `Gt` / `Ht` / `zt` / `Yt` / `qt` / `Vt` | `egEnabled` / `egSize` / `egAge` / `egGravityScale` / `egRestitution` / `egExplodeRadius` / `egStartSpin` / `egMaxThrowPower` / `egAmmoNeeded` / `egDelay1` / `egDelay2` / `egDelayBeforeAmmoUse` / `egAimRate` / `egShape` |
| `Kt` / `Xt` | `playerSize` (width / height) |
| `Zt` | `objectiveLimit` |
| `Qt` | credited kills before becoming a ghost |
| `$t` / `ti` / `ii` / `si` / `hi` / `ei` / `ni` / `oi` | ghost linear damping / move force / stamina regen / rocket speed / rocket radius / rocket age / rocket turn rate / rocket explode radius |
| `ri` | fixed spawn assignment (spawn index = player id) |

### Tick phases and event tags (step.rs, round.rs, objects.rs, player.rs, race.rs)

The original's per-tick handlers were named by two-letter tags. The Rust code uses the plain role of each handler:

| Original tag | Meaning | Rust name |
|---|---|---|
| `oo` | create physics bodies | create (objects.rs) |
| `mu` | run player input | player input (step.rs) |
| `qo` | apply join/leave events | join/leave events (step.rs) |
| `ao` | pre-step | `pre_step` |
| `ro` | post-step | `post_step` |
| `lo` | serialize every object into the next state | serialize |
| `wl` | BeginContact | begin-contact handler |
| `yl` | PostSolve | post-solve handler |
| `dl` | wrap a body around the arena | wrap |
| `ol` | impact sounds this tick | impact sounds |
| `el` | removed this tick | removed |
| `rl` | objective delivered for team | objective delivered |
| `al` | touched by a player (releases latched joints) | touched by player |
| `Tr` | a race object touched its next checkpoint | race checkpoint touch |
| `Ul` | hit point (explosion centre) | hit point |
| `Jl` | explosion impulse | explosion impulse |
| `Bl` | line-of-sight check | line-of-sight |
| `fl` | projectile damage | projectile damage |
| `Xu` / `Zu` | players touching per team / ids of touching players | touching players |
| `gu` / `yu` / `bu` / `vu` / `Su` / `ku` / `Cu` / `Tu` | bat swing / dash / parachute / grab / rocket / egg throw / ghosts float / ghost movement | `bat` / `dash` / `parachute` / `grab` / `rocket` / `egg` / `ghost_float` / `ghost_move` (player.rs) |
| `Ru` / `Wu` | grab anchor / grab ray | `grab_anchor` / `grab_ray` |
| `Ko` / `Zo` | player left / player joined with `team` | leave / join (round.rs) |
| `A_` / `O_` / `R_` | round modes: something changed (death/leave); someone joined; start of tick | round-mode handlers |
| `J_` | endless teams: the map has objective bodies | objective check |
| `Gn` / `Yn` / `Vn` / `Pn` | heav.io round-decision variants and the `recordMode` racer finish | round-decision branches |
| `H_` | take a life from the team pool | take life |
| `nr` | schedule a respawn | schedule respawn |
| `rr` | killer killed victim | kill |
| `lr` | suicide / environmental death | suicide |
| `W_` | record elimination order | record elimination |
| `U_` | last player with lives wins | last player wins |
| `dr` | objective delivered for `team` | objective |
| `pr` | all capture points owned by `owner` | capture points |
| `j_` | track the lowest lives left | min lives |
| `D_` | decide the round | decide round |
| `L_` | someone joined; end the round if at most one is alive | join end-round |
| `lo` (round) | countdowns, respawn timers, spawn claims, spawning | countdowns |
| `hr` | pick a spawn for every claim | pick spawns |
| `er` | players whose respawn countdown hit 0 | respawn ready |
| `ao` (round) | tick counter | `ticks` |
| `xo` / `_o` | game over / round over | game over / round over |
| `Ye` / `Tl` / `xa` | the player code paths (race.rs) | player |
| `Ye` / `Fr` / `Or` | the map body and race object code paths (race.rs) | body / race object |
| `jn` | game state (race.rs) | game state |
| `Tl` | send player (race.rs) | send player |
| `Jn` / `Wn` | a race object finished | race finish |
| `Ut` | inside the arena | in arena |
| `Mh` | reset counter; the reset key works while it is below 15 | `reset_count` |
| `yn` / `vn` | race data of the map | race data |
| `J$.ss` | sort candidates | sort |
| `hP` / `Tr` / `wr` / `Q_` / `nP` / `GL` | start-phase handlers (start.rs) | removed from comments |
| `iP` / `Lo` | the original's rotation flag | `rotation` |

Phrasing in code comments now describes the role directly. The Rust identifiers above are the names to search for.
