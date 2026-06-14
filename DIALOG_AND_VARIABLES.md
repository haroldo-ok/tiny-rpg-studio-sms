SMS RPG Studio — Dialog & variable system
==========================================

Conditional dialogs
-------------------
Each NPC has two dialogs:
  - dialog[]  (default text, NUL-terminated, 36 bytes)
  - dialog2[] (alternative shown when a game variable is set)

If the NPC's condition_var is in 0..31 AND that variable is "on" AND
dialog2[0] is non-zero, dialog2 is displayed. Otherwise dialog is used.

Game variables
--------------
32 boolean flags packed into 4 bytes of RAM (game_vars[4]).
Helpers: var_get(i), var_set(i).

When an NPC dialog closes:
  - Default branch  → reward_var      is set (if not 0xFF)
  - Conditional br. → cond_reward_var is set (if not 0xFF)

This lets you build quest chains:
  NPC A's default dialog sets var:0   "Find me a sword"
  NPC B's default dialog sets var:0   "I have a sword" (handing it)
  NPC A's condition_var = 0, dialog2 = "Thanks for the sword!"

The string variable IDs from TRS (`var:got_sword`, etc.) are mapped to
flat 0..31 indices by the JS generator. 'skill:bard' and any unknown
IDs map to 0xFF (no effect on SMS — there's no skill system in this port).

entities.dat format
-------------------
byte 0:        npc_count (max 16)
per NPC (79 bytes):
  0..3   : room, x, y, sprite_type
  4..39  : dialog[36]           (default)
  40..75 : dialog2[36]          (conditional)
  76     : condition_var        (0..31, or 0xFF=none)
  77     : reward_var
  78     : cond_reward_var
