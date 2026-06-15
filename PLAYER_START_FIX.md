Player start defensive fallback
================================

Bug: When adding "extras" (wooden-sign, thought-bubble) to a world that
already uses many distinct races/sprite-types, the player would be teleported
to map 2 on the first directional input.

Root cause: player_find_start() iterates the start room's map tiles looking
for the TILE_ATTR_PLAYER_START flag. If for any reason the flag isn't found,
the player stays at init_actor's default pixel position (32, 32). In grid
coordinates, that translates to (2, -1) — y is negative because MAP_SCREEN_Y
contributes a -48 pixel offset. The signed -1 wraps to 255 when the movement
handler casts it to unsigned char, and `_ty = 255 + delta` is always >= 8,
which makes the world-edge-crossing branch fire on the first input. That
branch picks the room to the right/down depending on the input direction.

Fix: player_find_start now sets a default (1, 1) position if no PLAYER_START
tile is found, so the player is always at a sane grid position regardless
of any other state.

The exact reason the start tile wasn't being detected when extras were added
isn't fully understood yet (it could be a quirk of the resource filesystem
layout shifting at a bank boundary). The defensive fallback masks the
symptom either way — the worst case is now "player spawns at (1, 1)" instead
of "game skips to a neighbouring map".
