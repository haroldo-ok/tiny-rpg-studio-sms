# Feature catalog

What's implemented in the SMS port beyond the base SMS-Puzzle-Maker engine.
Each subsystem has its own data file in the resource FS and a matching block
in the C base ROM. The JS encoder (`sms-generator.js`) produces all the data
files from `gameData` and writes the per-type BG tile numbers into a small
header at the top of each `.dat` file, so the C side stays agnostic to the
tile layout (which shifts whenever the number of BG tiles changes).

## NPCs and dialog

Per-NPC entry in `entities.dat` (79 bytes) — room, x, y, sprite type, two
dialog texts (36 chars each), `condition_var`, `reward_var`,
`cond_reward_var`. Walking into an NPC opens a dialog at SMS row 21.

A `condition_var` lets an NPC show a different dialog after a game-state
flag is set. The matching `cond_reward_var` is awarded when that conditional
dialog closes. With no conditional set, the regular dialog runs and its
`reward_var` fires.

Up to **32 NPCs total**, with **8 distinct sprite types per room**. Sprites
are loaded into VRAM slots 24..151 from `roomNN.spr` files when the room
becomes active.

## Variables (game state flags)

**32 boolean flags** stored as 4 bytes in `game_vars[]`. Set by
`var_set(idx)`, cleared by `var_clear(idx)`, tested with `var_get(idx)`.

Used by:
- NPC `condition_var` / `reward_var` / `cond_reward_var`
- `door-variable` (magic door) opens when its flag is on
- `switch` toggles its flag on every step-on

Each unique variable ID in the editor maps to one of the 32 indices at
encode time (`varToIdx` map in the JS). Indices persist across rooms.

## Objects (`objects.dat`)

10 supported types, encoded as 4-bit codes in each object entry:

| Type | Behavior |
|---|---|
| `key` | Walk-on → collect, `player_keys++`, tile becomes floor |
| `door` | Blocked unless `player_keys > 0`; consumes one key on open |
| `door-variable` | Blocked unless linked variable is on |
| `player-end` | Ends the game (victory); shows per-room ending text first |
| `switch` | Step-toggle; on/off visual + linked variable set/cleared |
| `life-potion` | Walk-on collectible; `player_lives++` |
| `xp-scroll` | Walk-on collectible; `player_xp++` |
| `sword` | Pickup if priority > current; sets sword type + durability |
| `sword-bronze` | Same, priority 2 (vs 3 for iron, 1 for wood) |
| `sword-wood` | Same, priority 1 |

Per-instance state (`OBJECT_STATE_DONE` / `OBJECT_STATE_ON`) lives in RAM
and persists across rooms. Once you collect a key it stays collected even
after edge-crossing to another room and back.

Objects render as **BG tiles**, not hardware sprites. Each type's pixel
matrix is composited onto `BG[0]` (the default floor) at encode time so
the object visually sits on grass rather than `palette[0]` (typically
black). When an object is consumed, the cell is rewritten with
`OBJECT_FLOOR_TILE` (= tile 1 = BG[0]) and `is_map_data_dirty` triggers a
VBlank redraw.

## Endgame (`endings.dat`)

One 36-byte ending text slot per room (9 × 36 = 324 bytes total). Read
from the player-end object's `endingText` in `gameData.objects`. When a
PLAYER_END object is stepped on:

1. If the room has non-empty ending text, it's shown in the dialog row
   and `pending_ending = 1`. `close_npc_dialog` finalizes the ending when
   the dialog is dismissed.
2. If the text is empty, the game ends immediately.

`player_won = 1` is set before ending, so `handle_gameover` shows
**`THE END`** for victory vs **`GAME OVER`** for combat defeat.

## Enemies (`enemies.dat`)

8 enemy types from TRS `EnemyDefinitions`, with per-type lookup tables
on the C side (no per-instance HP/ATK/XP in the data file, just `type`,
`room`, `x`, `y`):

| Type | HP | ATK | XP |
|---|---|---|---|
| giant-rat | 1 | 1 | 3 |
| bandit | 2 | 1 | 4 |
| skeleton | 3 | 1 | 5 |
| dark-knight | 4 | 2 | 7 |
| necromancer | 5 | 2 | 8 |
| dragon | 6 | 3 | 9 |
| fallen-king | 7 | 3 | 10 |
| ancient-demon | 8 | 3 | 11 |

Combat resolution mirrors TRS `handleCombatLegacy`: each collision is one
simultaneous exchange. Player deals `player_damage_for_sword()` (bare = 1,
wood = 2, bronze = 3, iron = 4), enemy deals its type's damage. Each
swing consumes one point of sword durability; at 0 the sword breaks.

If the enemy dies → tile becomes floor, player gains XP, player moves
into the cell. If the player dies → `game_ended = 1`, `player_won = 0`,
loop exits to `GAME OVER`.

Player starts each game with **3 lives** (`PLAYER_STARTING_LIVES`).
Life-potions stack on top.

Up to **32 enemies total**, stationary (no AI yet).

## HUD

Single-line status bar at SMS row 0 (above the play area, which starts
at `MAP_SCREEN_Y = 6`):

```
K:0 L:3 X:0                  Sw:-
```

- **Left**: keys / lives / XP counters as `%d` (so they grow naturally)
- **Right**: sword status — `Sw:Wd` / `Sw:Br` / `Sw:Fe` / `Sw:-`

Redrawn lazily: a `hud_dirty` flag is set on every state change
(pickups, door consumes a key, combat) and in the outer setup loop;
the draw itself happens in the same VBlank window the map redraw uses.

## Object/enemy tile layout (current)

After all features are in, the BG tile slot allocation looks like:

```
Tile  1            BG[0]                    (player/object/enemy default floor)
Tile  2..5         player sprite
Tile  6..37        NPC sprite types 0..7
Tile  38..(N+37)   BG[1..N]                 (N = liveTiles.length - 1)
Tile  N+38         player-start marker
Tile  N+39..N+49   object tiles             (11 slots, see OBJECT_TILE_NAMES)
Tile  N+50..N+57   enemy tiles              (8 slots)
```

The C side never hard-codes these — every per-type tile number is read
from a header at the top of the relevant `.dat` file.

## Why some things look the way they do

- **Bank caching**: the C runtime caches `map->width` / `map->height` in
  RAM globals (`current_map_width` / `current_map_height`) during
  `prepare_map_data`. Without this, calls to `load_room_sprites` or
  `get_tile_attr` would map a different bank, then a subsequent banked
  read of `map->width` returns garbage and the player teleports
  randomly. See `PLAYER_START_FIX.md`.

- **Compositing objects onto BG[0]**: there's no transparency on the
  SMS BG layer, so an object sprite's `null` pixels can't "show through"
  to the underlying floor. Instead, the JS substitutes the matching
  pixel from `BG[0]`'s art at encode time. The downside is that an
  object placed on a non-default floor tile still looks like it's on
  grass — fixable later with per-cell composition variants.

- **Lazy redraw**: the SMS can corrupt VRAM if you write outside VBlank
  while the display is rendering. Both `is_map_data_dirty` and
  `hud_dirty` defer their writes to the same VBlank window. Pickups
  set the flag; the next frame's VBlank picks it up.
