Bank-switching fix in player_find_start
========================================

Symptom
-------
With a world that uses many distinct NPC visuals (e.g. several races plus
wooden-sign / thought-bubble extras), the player would teleport to the
neighbouring map (typically map 2) on the very first directional input.

Root cause
----------
player_find_start() reads `map->tiles` directly from banked ROM:

    char *o = map->tiles;
    for (char y = 0; y != map->height; y++) {
        for (char x = 0; x != map->width; x++) {
            unsigned int tile_attr = get_tile_attr(*o);
            ...
        }
    }

get_tile_attr() in turn calls resource_get_pointer(tile_attrs), which
switches the ROM bank window to main.atr's bank. After that call, `o`
still points to the same logical address, but that address now exposes
the bytes of a DIFFERENT file (whichever was mapped in last). The next
iteration's `*o` reads garbage.

With small games that fit in one or two banks, the issue was masked
because both files happened to be co-resident. With the new per-room
sprite layout (~50 KB across 4 banks), main.atr and level001.map end up
in different banks, so the bug becomes deterministic.

The downstream symptom of garbage tile numbers is that some random
"tile" eventually returns a tile_attr with the TILE_ATTR_PLAYER_START
bit set, so the player is positioned at some (x,y) that doesn't
correspond to the real start tile. From there, the movement handler's
unsigned-char wraparound (-1 ⇒ 255) triggers the world-edge-crossing
branch on the first input.

Fix
---
1. player_find_start() now iterates the in-RAM `map_data` copy that
   prepare_map_data() already produced. Width and height are read once
   into locals before any banking happens. Bank switches inside
   get_tile_attr() no longer affect the iteration.

2. As an extra defense, if no PLAYER_START tile is found at all,
   the player defaults to (1, 1) instead of staying at init_actor's
   (32, 32) pixel position which would map to grid (2, -1) and trigger
   the same wraparound bug.

3. load_room_sprites() now caches e->size to a local before calling
   resource_get_pointer(e), since the call switches the ROM bank away
   from RESOURCE_BANK where the entry lives. C does not guarantee that
   the third function argument is evaluated before the first, so the
   original `SMS_loadTiles(resource_get_pointer(e), 24, e->size)` could
   read e->size from the wrong bank under some evaluation orders.
