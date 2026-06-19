SMS Objects Implementation
============================

Adds support for editor-placed objects: KEY, DOOR, DOOR_VARIABLE, PLAYER_END.

Behaviour (mirrors TRS InteractionManager + MovementManager)
------------------------------------------------------------
KEY            - Walk onto it, key picked up, BG tile replaced by floor, player_keys++.
DOOR           - Walk-into blocks the move unless player_keys > 0. Consumes one
                 key, replaces BG tile by floor, then the player moves into the cell.
DOOR_VARIABLE  - Walk-into blocks unless the linked variable is set (uses the same
                 32-flag system already used by NPC conditional dialogs and rewards).
                 When open, the BG tile becomes floor.
PLAYER_END     - Walk onto it, stage_clear = 1, the inner game loop exits and the
                 outer loop advances map_number — same flow used by TILE_ATTR_PLAYER_END.

Rendering
---------
Each of the 4 supported types gets one BG tile reserved in main.til, placed right
after the existing start-marker tile. apply_objects_to_map() paints the appropriate
tile into the in-RAM map_data for every active object in the current room.

The C side discovers the per-type tile numbers from a 4-byte header in objects.dat
(written by the JS encoder), so it stays agnostic to the BG-tile layout — which
varies with the number of BG tiles the user defined in the editor.

Persistence
-----------
- player_keys is reset only at gameplay_loop entry, not per-room. Keys carry
  across edge transitions and stage-clear advances.
- objects[].state bits (collected / opened) live in RAM and persist across room
  transitions too. Re-entering a room shows already-collected items as gone.
- load_objects() is called once at gameplay_loop entry, populating object_count
  and the per-type tile numbers from objects.dat.

Movement integration
--------------------
Move processing order (after NPC dialog check):
  1. find_object_at(room, target_x, target_y) — RAM-only lookup, O(MAX_OBJECTS)
  2. If hit: handle_object_at() runs the type-specific logic and returns 1 to
     allow the move into that cell, 0 to keep the player put.
  3. Otherwise: existing edge-crossing + try_moving_actor_on_map flow.

This means objects take priority over both edge-crossing and tile-attribute
checks. An object placed on an edge cell (x=7 or y=7) interacts normally — the
player will not be sent to the neighbour room when stepping on it.

Data file (objects.dat)
-----------------------
  Bytes 0..3   tile number for OBJ_TYPE_KEY .. OBJ_TYPE_PLAYER_END
  Byte 4       object_count (0..32)
  Bytes 5+     6 bytes per object: type, room, x, y, variable_id, flags
