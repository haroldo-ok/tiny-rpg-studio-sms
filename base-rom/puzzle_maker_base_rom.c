/*
 * SMS RPG Studio — Base ROM
 * Implements Tiny RPG Studio gameplay on the Sega Master System.
 *
 * World model (mirrors TRS exactly):
 *   - World is WORLD_ROWS × WORLD_COLS rooms
 *   - Walking off a room edge enters the adjacent room (same as TRS MovementManager)
 *   - NPCs, enemies, and objects are SMS hardware sprites on the same palette
 *   - Player start position stored in resource, no special tile needed
 *   - Exits (tile-based teleporters) supported via exits.dat
 *   - Dialog shown via text renderer
 */

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "lib/SMSlib.h"
#include "lib/PSGlib.h"
#include "actor.h"
#include "data.h"

/* ── Screen / world constants ─────────────────────────────── */
#define MAP_SCREEN_Y    3       /* BG tile rows reserved above map for HUD text */
#define ROOM_SIZE       8       /* tiles per room side */
#define MAX_ROOMS       9       /* 3×3 world */
#define WORLD_COLS      3
#define WORLD_ROWS      3

/* ── Resource system ──────────────────────────────────────── */
#define RESOURCE_BANK       2
#define RESOURCE_BASE_ADDR  0x8000

typedef struct { char signature[4]; unsigned int file_count; } res_header_t;
typedef struct { char name[14]; unsigned int page; unsigned int size; unsigned int offset; } res_entry_t;
typedef struct { unsigned int id; unsigned int width; unsigned int height; char name[32]; char tiles[]; } res_map_t;

const res_header_t *res_header = (const res_header_t *)RESOURCE_BASE_ADDR;
const res_entry_t  *res_entries= (const res_entry_t *)(RESOURCE_BASE_ADDR + sizeof(res_header_t));

res_entry_t *res_find(const char *name) {
    SMS_mapROMBank(RESOURCE_BANK);
    unsigned int n = res_header->file_count;
    res_entry_t *e = (res_entry_t *)res_entries;
    while (n--) {
        if (!strcmp(name, e->name)) return e;
        e++;
    }
    return 0;
}

void *res_ptr(res_entry_t *e) {
    if (!e) return 0;
    SMS_mapROMBank(e->page);
    return (void *)(RESOURCE_BASE_ADDR + e->offset);
}

/* ── Tile attributes (from main.atr) ─────────────────────── */
#define ATTR_SOLID   0x0001
res_entry_t *g_tile_attrs;

unsigned int tile_attr(unsigned char tile_num) {
    if (!tile_num) tile_num = 1;
    unsigned int *p = (unsigned int *)res_ptr(g_tile_attrs);
    return p[tile_num - 1];
}

/* ── Map storage ──────────────────────────────────────────── */
unsigned char g_map_tiles[MAX_ROOMS][ROOM_SIZE * ROOM_SIZE]; /* all rooms pre-loaded */

void load_all_maps(void) {
    char fname[14];
    for (unsigned char r = 0; r < MAX_ROOMS; r++) {
        sprintf(fname, "level%03d.map", (int)(r + 1));
        res_map_t *m = (res_map_t *)res_ptr(res_find(fname));
        if (m) {
            memcpy(g_map_tiles[r], m->tiles, ROOM_SIZE * ROOM_SIZE);
        } else {
            memset(g_map_tiles[r], 1, ROOM_SIZE * ROOM_SIZE);
        }
    }
}

unsigned char map_tile(unsigned char room, unsigned char x, unsigned char y) {
    return g_map_tiles[room][y * ROOM_SIZE + x];
}

/* ── Draw the BG tilemap for a room ──────────────────────── */
void draw_room(unsigned char room) {
    for (unsigned char y = 0; y < ROOM_SIZE; y++) {
        for (unsigned char x = 0; x < ROOM_SIZE; x++) {
            unsigned char tn = map_tile(room, x, y);
            unsigned int sms = (unsigned int)tn << 2;
            unsigned char sx = x << 1;
            unsigned char sy = (y << 1) + MAP_SCREEN_Y;
            SMS_setNextTileatXY(sx,   sy);     SMS_setTile(sms);   SMS_setTile(sms+2);
            SMS_setNextTileatXY(sx, sy + 1);   SMS_setTile(sms+1); SMS_setTile(sms+3);
        }
    }
}

/* ── World: room index ↔ (row, col) ──────────────────────── */
signed char room_index(unsigned char row, unsigned char col) {
    if (row >= WORLD_ROWS || col >= WORLD_COLS) return -1;
    return (signed char)(row * WORLD_COLS + col);
}
unsigned char room_row(unsigned char ri) { return ri / WORLD_COLS; }
unsigned char room_col(unsigned char ri) { return ri % WORLD_COLS; }

/* ── NPC / enemy / object data from resource ─────────────── */
#define MAX_NPCS    32
#define MAX_ENEMIES 32
#define MAX_OBJECTS 32
#define MAX_EXITS   32
#define MAX_DIALOG  128   /* chars per dialog string */

typedef struct {
    unsigned char placed;
    unsigned char room;
    unsigned char x, y;
    unsigned char sprite_idx;   /* index into g_sprite_tiles */
    char dialog[MAX_DIALOG];
} npc_t;

typedef struct {
    unsigned char alive;
    unsigned char room;
    unsigned char x, y;
    unsigned char sprite_idx;
    unsigned char lives;
    unsigned char damage;
} enemy_t;

typedef struct {
    unsigned char room;
    unsigned char x, y;
    unsigned char type;   /* 0=player-start, 1=player-end, 2=key, ... */
    unsigned char active;
} object_t;

typedef struct {
    unsigned char room;
    unsigned char x, y;
    unsigned char target_room;
    unsigned char target_x, target_y;
} exit_t;

npc_t    g_npcs[MAX_NPCS];
enemy_t  g_enemies[MAX_ENEMIES];
object_t g_objects[MAX_OBJECTS];
exit_t   g_exits[MAX_EXITS];

unsigned char g_npc_count;
unsigned char g_enemy_count;
unsigned char g_object_count;
unsigned char g_exit_count;

unsigned char g_start_room, g_start_x, g_start_y;

/* ── Sprite tiles in VRAM ─────────────────────────────────── */
/*
 * VRAM tile layout (SMS_loadTiles at slot 4):
 *   Slot  4- 7: BG tile index 0  (4 sub-tiles)
 *   Slot  8-23: player sprite  (16 SMS tiles = 4 frames × 4 sub-tiles)
 *   Slot 24-39: NPC/enemy/object sprites (16 tiles each, up to N types)
 *   Slot 40+ :  BG tile index 1, 2, … (4 sub-tiles each)
 *
 * Sprite tile numbers are written by the JS generator into main.til
 * and described in sprites.dat (see below).
 */
#define PLAYER_BASE_TILE  8   /* SMS hardware sprite tile for player */

/* ── Player state ─────────────────────────────────────────── */
unsigned char g_player_room;
unsigned char g_player_x, g_player_y;
unsigned char g_player_last_x;     /* for facing direction */

/* ── Dialog state ─────────────────────────────────────────── */
char g_dialog_text[MAX_DIALOG];
unsigned char g_dialog_active;

void show_dialog(const char *text) {
    strncpy(g_dialog_text, text, MAX_DIALOG - 1);
    g_dialog_text[MAX_DIALOG - 1] = 0;
    g_dialog_active = 1;
}

void draw_dialog(void) {
    if (!g_dialog_active) return;
    /* Draw a 2-row text box at the bottom of the screen */
    for (unsigned char x = 0; x < 32; x++) {
        SMS_setNextTileatXY(x, 22); SMS_setTile(0); /* blank row */
        SMS_setNextTileatXY(x, 23); SMS_setTile(0);
    }
    SMS_setNextTileatXY(0, 22);
    puts(g_dialog_text);
}

void close_dialog(void) {
    g_dialog_active = 0;
    /* Clear the dialog rows */
    for (unsigned char x = 0; x < 32; x++) {
        SMS_setNextTileatXY(x, 22); SMS_setTile(0);
        SMS_setNextTileatXY(x, 23); SMS_setTile(0);
    }
}

/* ── NPC sprite tile lookup ──────────────────────────────── */
/* The JS generator writes all sprite tiles sequentially in main.til.
 * sprites.dat contains: npc_type_count(u16), then for each NPC type:
 *   type_name[16], base_tile(u8)
 * Followed by enemy types the same way.
 * We look up base_tile for a given type at runtime.
 */
unsigned char g_sprite_base_tile[64]; /* indexed by sprite_idx */
unsigned char g_sprite_count;

/* We load sprite base tiles from sprites.dat */
void load_sprite_tiles(void) {
    res_entry_t *e = res_find("sprites.dat");
    if (!e) {
        /* Fallback: no sprites.dat → use contiguous allocation after player */
        g_sprite_count = 0;
        return;
    }
    unsigned char *p = (unsigned char *)res_ptr(e);
    g_sprite_count = *p++;
    for (unsigned char i = 0; i < g_sprite_count && i < 64; i++) {
        p += 16; /* skip name */
        g_sprite_base_tile[i] = *p++;
    }
}

/* ── Load entities from entities.dat ─────────────────────── */
/*
 * entities.dat format (written by JS generator):
 *   start_room(u8), start_x(u8), start_y(u8)
 *   npc_count(u8), then each NPC:
 *       room(u8), x(u8), y(u8), sprite_idx(u8), dialog[64]
 *   enemy_count(u8), then each enemy:
 *       room(u8), x(u8), y(u8), sprite_idx(u8), lives(u8), damage(u8)
 *   exit_count(u8), then each exit:
 *       room(u8), x(u8), y(u8), target_room(u8), target_x(u8), target_y(u8)
 */
void load_entities(void) {
    res_entry_t *e = res_find("entities.dat");
    if (!e) {
        g_start_room = 0; g_start_x = 1; g_start_y = 1;
        g_npc_count = 0; g_enemy_count = 0; g_exit_count = 0;
        return;
    }
    unsigned char *p = (unsigned char *)res_ptr(e);

    g_start_room = *p++;
    g_start_x    = *p++;
    g_start_y    = *p++;

    g_npc_count = *p++;
    for (unsigned char i = 0; i < g_npc_count && i < MAX_NPCS; i++) {
        g_npcs[i].placed     = 1;
        g_npcs[i].room       = *p++;
        g_npcs[i].x          = *p++;
        g_npcs[i].y          = *p++;
        g_npcs[i].sprite_idx = *p++;
        memcpy(g_npcs[i].dialog, p, MAX_DIALOG);
        g_npcs[i].dialog[MAX_DIALOG-1] = 0;
        p += MAX_DIALOG;
    }

    g_enemy_count = *p++;
    for (unsigned char i = 0; i < g_enemy_count && i < MAX_ENEMIES; i++) {
        g_enemies[i].alive      = 1;
        g_enemies[i].room       = *p++;
        g_enemies[i].x          = *p++;
        g_enemies[i].y          = *p++;
        g_enemies[i].sprite_idx = *p++;
        g_enemies[i].lives      = *p++;
        g_enemies[i].damage     = *p++;
    }

    g_exit_count = *p++;
    for (unsigned char i = 0; i < g_exit_count && i < MAX_EXITS; i++) {
        g_exits[i].room       = *p++;
        g_exits[i].x          = *p++;
        g_exits[i].y          = *p++;
        g_exits[i].target_room= *p++;
        g_exits[i].target_x   = *p++;
        g_exits[i].target_y   = *p++;
    }
}

/* ── Draw all sprites for current room ───────────────────── */
/* SMS sprite Y-offset: MAP_SCREEN_Y rows × 8 pixels */
#define MAP_Y_PX  (MAP_SCREEN_Y * 8)

void draw_sprites_for_room(unsigned char room) {
    SMS_initSprites();

    /* Player */
    unsigned char px = g_player_x * 16;
    unsigned char py = (unsigned char)(g_player_y * 16 + MAP_Y_PX);
    /* Facing: if moving left, use right-facing frames (base+8), else base */
    unsigned char player_frame = (g_player_x < g_player_last_x) ? (PLAYER_BASE_TILE + 8) : PLAYER_BASE_TILE;
    /* 2×1 tall sprite = 2 SMS_addSprite calls (char_w=2, SPRITEMODE_TALL) */
    SMS_addSprite(px,     py, player_frame);
    SMS_addSprite(px + 8, py, player_frame + 2);

    /* NPCs */
    for (unsigned char i = 0; i < g_npc_count; i++) {
        if (!g_npcs[i].placed || g_npcs[i].room != room) continue;
        unsigned char bt = (g_npcs[i].sprite_idx < g_sprite_count)
                           ? g_sprite_base_tile[g_npcs[i].sprite_idx] : PLAYER_BASE_TILE;
        unsigned char nx = g_npcs[i].x * 16;
        unsigned char ny = (unsigned char)(g_npcs[i].y * 16 + MAP_Y_PX);
        SMS_addSprite(nx,     ny, bt);
        SMS_addSprite(nx + 8, ny, bt + 2);
    }

    /* Enemies (alive only) */
    for (unsigned char i = 0; i < g_enemy_count; i++) {
        if (!g_enemies[i].alive || g_enemies[i].room != room) continue;
        unsigned char bt = (g_enemies[i].sprite_idx < g_sprite_count)
                           ? g_sprite_base_tile[g_enemies[i].sprite_idx] : PLAYER_BASE_TILE;
        unsigned char ex = g_enemies[i].x * 16;
        unsigned char ey = (unsigned char)(g_enemies[i].y * 16 + MAP_Y_PX);
        SMS_addSprite(ex,     ey, bt);
        SMS_addSprite(ex + 8, ey, bt + 2);
    }

    SMS_finalizeSprites();
}

/* ── Collision helpers ────────────────────────────────────── */
unsigned char npc_at(unsigned char room, unsigned char x, unsigned char y) {
    for (unsigned char i = 0; i < g_npc_count; i++) {
        if (g_npcs[i].placed && g_npcs[i].room == room &&
            g_npcs[i].x == x && g_npcs[i].y == y) return i + 1; /* 1-based */
    }
    return 0;
}

unsigned char enemy_at(unsigned char room, unsigned char x, unsigned char y) {
    for (unsigned char i = 0; i < g_enemy_count; i++) {
        if (g_enemies[i].alive && g_enemies[i].room == room &&
            g_enemies[i].x == x && g_enemies[i].y == y) return i + 1;
    }
    return 0;
}

/* ── Movement: exactly mirrors TRS MovementManager::tryMove ─ */
void try_move(signed char dx, signed char dy) {
    if (g_dialog_active) {
        close_dialog();
        return;
    }

    signed char tx = (signed char)g_player_x + dx;
    signed char ty = (signed char)g_player_y + dy;

    unsigned char new_room  = g_player_room;
    unsigned char new_x     = g_player_x;
    unsigned char new_y     = g_player_y;

    unsigned char cur_row   = room_row(g_player_room);
    unsigned char cur_col   = room_col(g_player_room);
    unsigned char limit     = ROOM_SIZE - 1;

    /* Edge transitions (same logic as TRS getRoomCoords + getRoomIndex) */
    if (tx < 0) {
        signed char nb = room_index(cur_row, cur_col > 0 ? cur_col - 1 : 255);
        if (nb >= 0) { new_room = (unsigned char)nb; tx = limit; }
        else tx = 0;
    } else if (tx > (signed char)limit) {
        signed char nb = room_index(cur_row, cur_col + 1);
        if (nb >= 0) { new_room = (unsigned char)nb; tx = 0; }
        else tx = limit;
    }
    if (ty < 0) {
        signed char nb = room_index(cur_row > 0 ? cur_row - 1 : 255, cur_col);
        if (nb >= 0) { new_room = (unsigned char)nb; ty = limit; }
        else ty = 0;
    } else if (ty > (signed char)limit) {
        signed char nb = room_index(cur_row + 1, cur_col);
        if (nb >= 0) { new_room = (unsigned char)nb; ty = 0; }
        else ty = limit;
    }

    new_x = (unsigned char)tx;
    new_y = (unsigned char)ty;

    /* Solid tile collision */
    unsigned char tn = map_tile(new_room, new_x, new_y);
    if (tile_attr(tn) & ATTR_SOLID) return;

    /* NPC blocking + dialog (mirrors TRS: findNpcAt → show dialog, block move) */
    unsigned char ni = npc_at(new_room, new_x, new_y);
    if (ni) {
        show_dialog(g_npcs[ni-1].dialog);
        return;
    }

    /* Enemy: block move (combat not implemented in base ROM — extend as needed) */
    if (enemy_at(new_room, new_x, new_y)) return;

    /* Commit move */
    g_player_last_x = g_player_x;
    g_player_x      = new_x;
    g_player_y      = new_y;

    /* Room change: reload BG */
    if (new_room != g_player_room) {
        g_player_room = new_room;
        draw_room(g_player_room);
    }

    /* Exit teleporters (mirrors TRS checkRoomExits) */
    for (unsigned char i = 0; i < g_exit_count; i++) {
        if (g_exits[i].room == g_player_room &&
            g_exits[i].x == g_player_x && g_exits[i].y == g_player_y) {
            unsigned char tr = g_exits[i].target_room;
            if (tr < MAX_ROOMS) {
                g_player_room = tr;
                g_player_x    = g_exits[i].target_x;
                g_player_y    = g_exits[i].target_y;
                draw_room(g_player_room);
            }
            break;
        }
    }
}

/* ── HUD ──────────────────────────────────────────────────── */
void draw_hud(void) {
    /* Room name in top-left (row 0) */
    SMS_setNextTileatXY(0, 0);
    char fname[14];
    sprintf(fname, "level%03d.map", (int)(g_player_room + 1));
    res_map_t *m = (res_map_t *)res_ptr(res_find(fname));
    if (m) puts(m->name); else puts("Room");

    /* Room indicator: e.g. "[2,1]" */
    SMS_setNextTileatXY(0, 1);
    printf("[%d,%d]", (int)room_row(g_player_room)+1, (int)room_col(g_player_room)+1);
}

/* ── Initialise graphics ──────────────────────────────────── */
void init_graphics(void) {
    SMS_waitForVBlank();
    SMS_displayOff();
    SMS_disableLineInterrupt();

    SMS_VRAMmemsetW(0, 0, 16 * 1024);

    /* Font at tile slot 352 */
    SMS_load1bppTiles(font_1bpp, 352, font_1bpp_size, 0, 1);
    SMS_configureTextRenderer(352 - 32);

    SMS_mapROMBank(RESOURCE_BANK);
    SMS_loadBGPalette(res_ptr(res_find("main.pal")));
    SMS_loadSpritePalette(res_ptr(res_find("main.pal")));

    /* Load BG + sprite tiles (use actual file size, not hardcoded) */
    {
        res_entry_t *til_entry = res_find("main.til");
        SMS_loadTiles(res_ptr(til_entry), 4, til_entry ? til_entry->size : 0);
    }

    g_tile_attrs = res_find("main.atr");
}

/* ── Title screen ─────────────────────────────────────────── */
void handle_title(void) {
    init_graphics();

    unsigned char *app = (unsigned char *)res_ptr(res_find("project.inf"));
    /* project.inf: tool_name\0 version\0 title\0 */
    char *tool    = (char *)app;
    char *ver     = tool + strlen(tool) + 1;
    char *project = ver  + strlen(ver)  + 1;

    SMS_setNextTileatXY(2, 2); printf("%s %s", tool, ver);
    SMS_setNextTileatXY(2, 4); puts(project);
    SMS_setNextTileatXY(2, 21); puts("Press any button to start");

    SMS_displayOn();

    unsigned int joy;
    do { SMS_waitForVBlank(); joy = SMS_getKeysStatus(); }
    while (!(joy & (PORT_A_KEY_1|PORT_A_KEY_2)));
    do { SMS_waitForVBlank(); joy = SMS_getKeysStatus(); }
    while  (joy & (PORT_A_KEY_1|PORT_A_KEY_2));
}

/* ── Main game loop ───────────────────────────────────────── */
void gameplay_loop(void) {
    init_graphics();
    load_all_maps();
    load_sprite_tiles();
    load_entities();

    /* Place player at start */
    g_player_room   = g_start_room;
    g_player_x      = g_start_x;
    g_player_y      = g_start_y;
    g_player_last_x = g_start_x;
    g_dialog_active = 0;

    draw_room(g_player_room);
    draw_hud();
    SMS_displayOn();

    unsigned int joy = 0, joy_prev = 0;
    unsigned char joy_delay = 0;

    while (1) {
        /* Input with auto-repeat delay (same feel as TRS) */
        if (joy_delay) joy_delay--;
        if (!joy_delay || joy != joy_prev) {
            if      (joy & PORT_A_KEY_UP)    try_move( 0, -1);
            else if (joy & PORT_A_KEY_DOWN)  try_move( 0,  1);
            else if (joy & PORT_A_KEY_LEFT)  try_move(-1,  0);
            else if (joy & PORT_A_KEY_RIGHT) try_move( 1,  0);
            else if ((joy & (PORT_A_KEY_1|PORT_A_KEY_2)) && g_dialog_active) close_dialog();
            if (joy) joy_delay = 8;
        }

        draw_sprites_for_room(g_player_room);
        if (g_dialog_active) draw_dialog();

        SMS_waitForVBlank();
        SMS_copySpritestoSAT();

        joy_prev = joy;
        joy = SMS_getKeysStatus();
    }
}

/* ── Entry point ──────────────────────────────────────────── */
void main(void) {
    SMS_useFirstHalfTilesforSprites(1);
    SMS_setSpriteMode(SPRITEMODE_TALL);

    handle_title();
    gameplay_loop();
}

SMS_EMBED_SEGA_ROM_HEADER(9999, 0);
SMS_EMBED_SDSC_HEADER(1, 0, 2025, 6, 2, "SMS-RPG-Studio",
    "SMS RPG Studio Base ROM",
    "Ported from Tiny RPG Studio. devkitSMS & SMSlib.");
