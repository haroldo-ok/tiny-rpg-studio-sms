Bank-safety fix for runtime map field reads
=============================================

Symptom
-------
On worlds with many distinct NPC visuals plus "extras" (wooden-sign,
thought-bubble), the player would teleport to map 2 on the first
directional input. After that single glitch, the rest of the game
behaved correctly.

Root cause
----------
Several C runtime functions read `map->width` and `map->height` directly
from the level file's struct, which lives in banked ROM. The bank
window containing the level file is overwritten by every later
`resource_get_pointer` call. By the time the first input is processed,
the bank is mapped to either main.atr (from `get_tile_attr`) or
roomNN.spr (from `load_room_sprites`), and reading `map->width` returns
whatever byte sits at offset 2 of that other file.

When the garbage width is used in `get_map_tile_pointer`, the offset
calculation lands outside the `map_data` array. Whichever RAM byte sits
at that bogus offset gets interpreted as a tile number and fed to
`get_tile_attr`. With enough resources in the FS (≥24 NPCs + 9 per-room
sprite files spanning four banks), that random byte often produced an
attribute word with `TILE_ATTR_PLAYER_END` (bit 0x04) set. That sets
`stage_clear = 1`, the inner do/while exits, `map_number++`, and the
outer while restarts on map 2 with consistent bank state — which is why
the bug only happened once.

Why small worlds were unaffected
--------------------------------
With only one or two banks of resources, several files were co-resident
in the same 16KB window. Even after a bank switch, `map->width` happened
to land on a byte that arithmetic happened to make harmless. The bug was
latent, not absent.

Fix
---
Cache the level dimensions in RAM in `prepare_map_data`:

    unsigned char current_map_width  = 8;
    unsigned char current_map_height = 8;

Every runtime function that previously read `map->width` / `map->height`
(`get_map_tile_pointer`, `draw_map`, `try_moving_actor_on_map`,
`try_pushing_tile_on_map`, `player_find_start`) now reads from the RAM
globals instead. Bank switches no longer affect map dimensions.

Supporting fixes
----------------
- `player_find_start` reads the in-RAM `map_data` copy instead of
  `map->tiles` (banked), since `get_tile_attr` inside the loop switches
  the bank.
- `player_find_start` defaults to (1,1) if no `PLAYER_START` tile is
  found, so corrupted attribute reads cannot leave the player at
  `init_actor`'s default pixel (32,32), which maps to grid (2,-1) and
  triggers a different edge-cross wraparound bug.
- `load_room_sprites` caches `e->size` before `resource_get_pointer`,
  since C does not guarantee the third function argument is evaluated
  before the first; the call switches the bank away from RESOURCE_BANK
  where `e` lives.
