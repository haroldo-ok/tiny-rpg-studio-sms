Per-room sprite loading
========================

Each room now has its own set of up to 8 NPC sprite types. This lets a game
have unlimited total NPC types as long as each room uses no more than 8.

JS side (sms-generator.js):
  - For each placed NPC, normalizeNpcType(npc) determines the sprite key,
    using both npc.type and npc.variant (TRS stores race in variant).
  - roomTypeMaps[r] is a Map: sprite_name → per-room slot (0..7).
  - One sprite file is emitted per room: room01.spr through room09.spr.
    Each file = 8 sprite types × 16 sub-tiles × 32 bytes = 4096 bytes.
  - entities.dat byte 3 (sprite_type) is the PER-ROOM slot index.

C side (puzzle_maker_base_rom.c):
  - MAX_NPCS bumped 16 → 32.
  - load_room_sprites(room_idx) reads roomNN.spr and loads it into
    VRAM slots 24..151 (the NPC sprite region).
  - Called at startup AND on every room transition, before init_npc_actors.

Total resource size: ~50KB → 4 ROM pages. Mapper handles this fine.
