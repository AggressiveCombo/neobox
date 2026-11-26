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
