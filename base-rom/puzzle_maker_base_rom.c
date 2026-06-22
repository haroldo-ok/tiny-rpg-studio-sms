#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "lib/SMSlib.h"
#include "lib/PSGlib.h"
#include "data.h"
#include "actor.h"

#define SCREEN_W (256)
#define SCREEN_H (192)
#define SCROLL_H (224)

#define STATE_START (1)
#define STATE_GAMEPLAY (2)
#define STATE_GAMEOVER (3)

#define RESOURCE_BANK (2)
#define RESOURCE_BASE_ADDR (0x8000)

#define MAP_SCREEN_Y (6)

#define TILE_ATTR_SOLID (0x0001)
#define TILE_ATTR_PLAYER_START (0x0002)
#define TILE_ATTR_PLAYER_END (0x0004)
#define TILE_ATTR_PUSHABLE (0x0008)

actor player;

typedef struct resource_header_format {
	char signature[4];
	unsigned int file_count;
} resource_header_format;

typedef struct resource_entry_format {
	char name[14];
	unsigned int page;
	unsigned int size;
	unsigned int offset;
} resource_entry_format;

typedef struct resource_map_format {
	unsigned int id;
	unsigned int width;
	unsigned int height;
	char name[32];
	char tiles[];
} resource_map_format;

const resource_header_format *resource_header = RESOURCE_BASE_ADDR;
const resource_entry_format *resource_entries = RESOURCE_BASE_ADDR + sizeof(resource_header_format);

resource_entry_format *tile_attrs;
resource_entry_format *tile_combinations;
char stage_clear;

char map_data[9*16], map_floor[9*16];
char is_map_data_dirty;
/* Cached map dimensions, populated by prepare_map_data().
   We avoid reading map->width / map->height at runtime because that
   would require the map's ROM bank to be mapped at that moment — and
   subsequent calls to load_room_sprites / get_tile_attr / etc. switch
   the bank away. With large games (multiple banks of resources) the
   stale banked reads return garbage. */
unsigned char current_map_width  = 8;
unsigned char current_map_height = 8;

resource_entry_format *resource_find(char *name) {
	SMS_mapROMBank(RESOURCE_BANK);

	// TODO: Implement binary search; the names are already sorted.
	// Searches sequentially, for now.
	unsigned int remaining_entries = resource_header->file_count;
	resource_entry_format *entry = resource_entries;
	while (remaining_entries) {
		if (!strcmp(name, entry->name)) {
			return entry;
		}
		
		entry++;
		remaining_entries--;
	}
	
	return 0;
}

char *resource_get_pointer(resource_entry_format *entry) {
	SMS_mapROMBank(RESOURCE_BANK);
	
	if (!entry) return 0;
	
	unsigned int page = entry->page;
	char *p = RESOURCE_BASE_ADDR + entry->offset;
	
	SMS_mapROMBank(page);
	return p;
}

void load_standard_palettes() {
	SMS_setBGPaletteColor(0, 0);
	SMS_setBGPaletteColor(1, 0x3F);
}

void draw_tile(char x, char y, unsigned int tileNumber) {
	static unsigned int sms_tile;
	
	y += MAP_SCREEN_Y;
	
	sms_tile = tileNumber << 2;
	
	SMS_setNextTileatXY(x, y);	
	SMS_setTile(sms_tile);
	SMS_setTile(sms_tile + 2);

	SMS_setNextTileatXY(x, y + 1);
	SMS_setTile(sms_tile + 1);
	SMS_setTile(sms_tile + 3);
}

inline char *get_map_tile_pointer(resource_map_format *map, char *data, char x, char y) {
	/* Use the cached width to avoid banked read of map->width.
	   The map parameter is kept for API compatibility. */
	(void)map;
	return data + (y * current_map_width) + x;
}

char get_map_tile(resource_map_format *map, char x, char y) {
	return *(get_map_tile_pointer(map, map_data, x, y));
}

void set_map_tile(resource_map_format *map, char x, char y, char new_value) {
	*(get_map_tile_pointer(map, map_data, x, y)) = new_value;
}

char get_floor_tile(resource_map_format *map, char x, char y) {
	return *(get_map_tile_pointer(map, map_floor, x, y));
}

void set_floor_tile(resource_map_format *map, char x, char y, char new_value) {
	*(get_map_tile_pointer(map, map_floor, x, y)) = new_value;
}

unsigned int get_tile_attr(char tile_number) {
	if (!tile_number) tile_number = 1;
	unsigned int *tile_attr_p = resource_get_pointer(tile_attrs);
	return tile_attr_p[tile_number - 1];	
}

char get_tile_combination(char source_tile, char dest_tile) {
	if (!source_tile) source_tile = 1;
	if (!dest_tile) dest_tile = 1;
	
	char *tile_combos = resource_get_pointer(tile_combinations);
	unsigned int tile_count = *((unsigned int *) tile_combos);
	tile_combos += 2;
	
	return tile_combos[tile_count * (source_tile - 1) + (dest_tile - 1)];
}

resource_map_format *load_map(int n) {
	char map_file_name[14];
	sprintf(map_file_name, "level%03d.map", n);
	resource_map_format *map = (resource_map_format *) resource_get_pointer(resource_find(map_file_name));
	return map;
}

void prepare_map_data(resource_map_format *map) {
	/* Cache the dimensions while map's ROM bank is still mapped.
	   Subsequent ROM-bank switches (e.g. load_room_sprites or
	   get_tile_attr) make map->width / map->height unreadable. */
	current_map_width  = (unsigned char)map->width;
	current_map_height = (unsigned char)map->height;
	memcpy(map_data, map->tiles, (unsigned int)current_map_height * current_map_width);
	memcpy(map_floor, 0, (unsigned int)current_map_height * current_map_width);
}

void draw_map(resource_map_format *map) {
	/* Use cached dimensions, not banked struct fields. */
	(void)map;
	char *o = map_data;
	for (char y = 0; y != (char)current_map_height; y++) {
		for (char x = 0; x != (char)current_map_width; x++) {
			draw_tile(x << 1, y << 1, *o);
			o++;
		}
	}
}

char get_actor_map_x(actor *act) {
	return act->x >> 4;
}

char get_actor_map_y(actor *act) {
	return (act->y - (MAP_SCREEN_Y << 3)) >> 4;
}

void set_actor_map_xy(actor *act, char x, char y) {
	act->x = x << 4;
	act->y = (y << 4) + (MAP_SCREEN_Y << 3);
}

char try_pushing_tile_on_map(resource_map_format *map, char x, char y, signed char delta_x, signed char delta_y) {
	char new_x = x + delta_x;
	char new_y = y + delta_y;
	if (new_x >= (char)current_map_width || new_y >= (char)current_map_height) return 0;

	char target_tile = get_map_tile(map, new_x, new_y);
	char source_tile = get_map_tile(map, x, y);	
	
	char tile_combination = get_tile_combination(source_tile, target_tile);
	if (tile_combination) {
		char source_floor_tile = get_floor_tile(map, x, y);
		
		set_map_tile(map, x, y, source_floor_tile ? source_floor_tile : 1);
		set_map_tile(map, new_x, new_y, tile_combination);
		
		return 1;
	}
	
	unsigned int target_tile_attr = get_tile_attr(target_tile);	
	
	if (target_tile_attr & TILE_ATTR_SOLID) return 0;

	char source_floor_tile = get_floor_tile(map, x, y);
	
	set_map_tile(map, x, y, source_floor_tile ? source_floor_tile : 1);
	set_map_tile(map, new_x, new_y, source_tile);
	
	set_floor_tile(map, new_x, new_y, target_tile);

	is_map_data_dirty = 1;
	
	return 1;
}

void try_moving_actor_on_map(actor *act, resource_map_format *map, signed char delta_x, signed char delta_y) {
	char x = get_actor_map_x(act);
	char y = get_actor_map_y(act);
	
	char new_x = x + delta_x;
	char new_y = y + delta_y;
	if (new_x >= (char)current_map_width || new_y >= (char)current_map_height) return;
	
	char tile = get_map_tile(map, new_x, new_y);
	unsigned int tile_attr = get_tile_attr(tile);	

	if (tile_attr & TILE_ATTR_PLAYER_END) stage_clear = 1;
	
	if (tile_attr & TILE_ATTR_PUSHABLE) {
		if (!try_pushing_tile_on_map(map, new_x, new_y, delta_x, delta_y)) return;
	} else if (tile_attr & TILE_ATTR_SOLID) {
		return;
	}
	
	set_actor_map_xy(act, new_x, new_y);
}

void player_find_start(resource_map_format *map) {
	/* Read map tile data from the RAM copy populated by prepare_map_data.
	   Dimensions come from the cached globals (current_map_width/height)
	   instead of map->width/height, since get_tile_attr() inside the loop
	   switches the ROM bank to main.atr's bank. That would make any
	   subsequent banked read of map->* return garbage. */
	(void)map;
	char *o = map_data;
	char found = 0;
	for (char y = 0; y != (char)current_map_height; y++) {
		for (char x = 0; x != (char)current_map_width; x++) {
			unsigned int tile_attr = get_tile_attr(*o);
			if (tile_attr & TILE_ATTR_PLAYER_START) {
				set_actor_map_xy(&player, x, y);
				found = 1;
			}
			o++;
		}
	}
	/* Defensive fallback if no PLAYER_START tile is in the map. */
	if (!found) set_actor_map_xy(&player, 1, 1);
}

char *skip_after_end_of_string(char *s) {
	while (*s) s++;
	return s + 1;
}

void initialize_graphics() {
	SMS_waitForVBlank();
	SMS_displayOff();
	SMS_disableLineInterrupt();
	
	load_standard_palettes();
	
	SMS_VRAMmemsetW(0, 0, 16 * 1024); 

	SMS_load1bppTiles(font_1bpp, 352, font_1bpp_size, 0, 1);
	SMS_configureTextRenderer(352 - 32);
	
	SMS_mapROMBank(RESOURCE_BANK);
	
	SMS_loadBGPalette(resource_get_pointer(resource_find("main.pal")));
	SMS_loadSpritePalette(resource_get_pointer(resource_find("main.pal")));
}

void wait_button_press() {
	unsigned int joy;
	
	// Wait button press
	do {
		SMS_waitForVBlank();
		joy = SMS_getKeysStatus();
	} while (!(joy & (PORT_A_KEY_1 | PORT_A_KEY_2 | PORT_B_KEY_1 | PORT_B_KEY_2)));
}

void wait_button_release() {
	unsigned int joy;
	
	// Wait button release
	do {
		SMS_waitForVBlank();
		joy = SMS_getKeysStatus();
	} while ((joy & (PORT_A_KEY_1 | PORT_A_KEY_2 | PORT_B_KEY_1 | PORT_B_KEY_2)));
}

#define MAX_NPC_SPRITE_TYPES (8)
#define MAX_NPCS (32)
#define NPC_DIALOG_LEN (36)
#define NPC_ENTRY_LEN (4 + 2 * NPC_DIALOG_LEN + 3) /* room,x,y,type + 2 dialogs + 3 var ids */
#define NPC_BASE_TILE(t) ((unsigned char)(8 + 16 + (unsigned char)(t) * 16))
#define VAR_NONE (0xFF)
#define NUM_GAME_VARS (32)

typedef struct {
	unsigned char room;
	unsigned char x;
	unsigned char y;
	unsigned char sprite_type;
	char          dialog[NPC_DIALOG_LEN];
	char          dialog2[NPC_DIALOG_LEN];
	unsigned char condition_var;
	unsigned char reward_var;
	unsigned char cond_reward_var;
} npc_t;

static npc_t         npc_data[MAX_NPCS];
static actor         npc_actors[MAX_NPCS];
static unsigned char npc_count;
static char          dialog_active;
static unsigned char pending_reward_var;
static unsigned char game_vars[NUM_GAME_VARS / 8]; /* 32 boolean flags */
static unsigned char world_cols;
static unsigned char world_rows;

/* ── Game variable system ──
   Global boolean flags settable by NPC dialogs.
   Used to gate alternative dialogs and rewards. */
static unsigned char var_get(unsigned char i) {
	if (i >= NUM_GAME_VARS) return 0;
	return (unsigned char)((game_vars[i >> 3] >> (i & 7)) & 1);
}
static void var_set(unsigned char i) {
	if (i >= NUM_GAME_VARS) return;
	game_vars[i >> 3] |= (unsigned char)(1 << (i & 7));
}
static void var_clear(unsigned char i) {
	if (i >= NUM_GAME_VARS) return;
	game_vars[i >> 3] &= (unsigned char)~(1 << (i & 7));
}
/* ── Object system ──
   Objects (keys, doors, magic doors, player-end) are placed on the map
   in the editor and stored in a runtime array. Each object instance
   tracks its position, type, and state (collected/opened).
   
   At map-load time, apply_objects_to_map() paints object BG tiles onto
   map_data based on the current room and each object's state.
   
   During movement, find_object_at() locates any object at the player's
   target position. handle_object_at() then runs the type-specific logic
   (collect a key, consume a key to open a door, check a variable for a
   magic door, or set stage_clear for a player-end) and reports whether
   the player should actually move into the cell.                  */

#define MAX_OBJECTS (32)
/* Object TYPE codes. Match OBJ_TYPE_MAP on the JS side. */
#define OBJ_TYPE_KEY            (0)
#define OBJ_TYPE_DOOR           (1)
#define OBJ_TYPE_DOOR_VARIABLE  (2)
#define OBJ_TYPE_PLAYER_END     (3)
#define OBJ_TYPE_SWITCH         (4)
#define OBJ_TYPE_LIFE_POTION    (5)
#define OBJ_TYPE_XP_SCROLL      (6)
#define OBJ_TYPE_SWORD          (7)
#define OBJ_TYPE_SWORD_BRONZE   (8)
#define OBJ_TYPE_SWORD_WOOD     (9)
#define N_OBJ_TYPES             (10)
/* TILE indices in the objects.dat header. SWITCH contributes two slots
   (off + on visual); the other entries are 1:1 with their type code. */
#define OBJ_TILE_KEY            (0)
#define OBJ_TILE_DOOR           (1)
#define OBJ_TILE_DOOR_VARIABLE  (2)
#define OBJ_TILE_PLAYER_END     (3)
#define OBJ_TILE_SWITCH_OFF     (4)
#define OBJ_TILE_SWITCH_ON      (5)
#define OBJ_TILE_LIFE_POTION    (6)
#define OBJ_TILE_XP_SCROLL      (7)
#define OBJ_TILE_SWORD          (8)
#define OBJ_TILE_SWORD_BRONZE   (9)
#define OBJ_TILE_SWORD_WOOD     (10)
#define N_OBJ_TILES             (11)
#define OBJECT_FLOOR_TILE       (1)   /* tile to draw after collect/open */
#define OBJECT_STATE_DONE       (0x01)
#define OBJECT_STATE_ON         (0x02)
#define ENDING_TEXT_LEN         (36)  /* matches NPC_DIALOG_LEN */

typedef struct {
	unsigned char type;
	unsigned char room;
	unsigned char x;
	unsigned char y;
	unsigned char variable_id;
	unsigned char state;
} object_t;

static object_t      objects[MAX_OBJECTS];
static unsigned char object_count;
static unsigned char player_keys;
static unsigned char player_lives;
static unsigned char player_xp;
static unsigned char player_sword_type;       /* 0 = none */
static unsigned char player_sword_durability;
/* Game-ending state. PLAYER_END objects show a per-room ending text
   in the dialog row, then end the game when the dialog closes. */
static char          game_ended;
static char          pending_ending;
static char          player_end_texts[9][ENDING_TEXT_LEN];
/* HUD: a one-line status bar at the very top of the screen showing
   keys / lives / XP / sword. Redrawn lazily when hud_dirty is set —
   pickups set it, and the gameplay loop draws + clears it during the
   same VBlank window the map redraw uses. */
static char          hud_dirty;

static unsigned char sword_priority(unsigned char type) {
	switch (type) {
		case OBJ_TYPE_SWORD_WOOD:   return 1;
		case OBJ_TYPE_SWORD_BRONZE: return 2;
		case OBJ_TYPE_SWORD:        return 3;
		default:                    return 0;
	}
}

static unsigned char sword_durability_for(unsigned char type) {
	switch (type) {
		case OBJ_TYPE_SWORD_WOOD:   return 2;
		case OBJ_TYPE_SWORD_BRONZE: return 3;
		case OBJ_TYPE_SWORD:        return 5;
		default:                    return 0;
	}
}

/* Forward declaration: handle_object_at (defined upstream) shows the
   per-room ending text via this function when PLAYER_END fires. */
static void show_npc_dialog(char *text);

static void load_endings(void) {
	unsigned char *p;
	resource_entry_format *e;
	unsigned char r, i;

	for (r = 0; r < 9; r++) {
		for (i = 0; i < ENDING_TEXT_LEN; i++) player_end_texts[r][i] = 0;
	}

	e = resource_find("endings.dat");
	if (!e) return;
	if (e->size < (unsigned int)(9 * ENDING_TEXT_LEN)) return;
	p = (unsigned char *)resource_get_pointer(e);
	if (!p) return;

	for (r = 0; r < 9; r++) {
		for (i = 0; i < ENDING_TEXT_LEN; i++) {
			player_end_texts[r][i] = (char)p[r * ENDING_TEXT_LEN + i];
		}
		player_end_texts[r][ENDING_TEXT_LEN - 1] = 0;
	}
}
/* Per-type BG tile numbers; filled from the header of objects.dat.
   The JS encoder writes these as the first N_OBJ_TILES bytes so the
   C side stays agnostic to the BG-tile-count + object-tile layout.
   Indices: KEY, DOOR, DOOR_VARIABLE, PLAYER_END, SWITCH_OFF, SWITCH_ON. */
static unsigned char object_tile_for_type[N_OBJ_TILES];

static void load_objects(void) {
	unsigned char i;
	unsigned char *p;
	resource_entry_format *e;

	object_count = 0;
	for (i = 0; i < N_OBJ_TILES; i++) object_tile_for_type[i] = 0;

	e = resource_find("objects.dat");
	if (!e) return;
	if (e->size < (unsigned int)(N_OBJ_TILES + 1)) return;
	p = (unsigned char *)resource_get_pointer(e);
	if (!p) return;

	for (i = 0; i < N_OBJ_TILES; i++) object_tile_for_type[i] = p[i];
	p += N_OBJ_TILES;

	object_count = *p++;
	if (object_count > MAX_OBJECTS) object_count = MAX_OBJECTS;

	for (i = 0; i < object_count; i++) {
		objects[i].type        = *p++;
		objects[i].room        = *p++;
		objects[i].x           = *p++;
		objects[i].y           = *p++;
		objects[i].variable_id = *p++;
		objects[i].state       = 0;
		p++;  /* reserved flags byte */
	}
}

/* Paint not-yet-consumed objects of the given room onto map_data.
   Skips the player-start cell so player_find_start can still locate it
   on the initial map setup (called after player_find_start there).
   For switches, picks the OFF or ON tile based on the OBJECT_STATE_ON bit.
   Types after SWITCH (which uses two tile slots) shift up by one. */
static void apply_objects_to_map(unsigned char room) {
	unsigned char i, idx, tile_index, tile;
	for (i = 0; i < object_count; i++) {
		if (objects[i].room != room) continue;
		if (objects[i].state & OBJECT_STATE_DONE) continue;
		if (objects[i].type >= N_OBJ_TYPES) continue;
		if (objects[i].x >= 8 || objects[i].y >= 8) continue;
		switch (objects[i].type) {
			case OBJ_TYPE_SWITCH:
				tile_index = (objects[i].state & OBJECT_STATE_ON)
					? OBJ_TILE_SWITCH_ON : OBJ_TILE_SWITCH_OFF;
				break;
			case OBJ_TYPE_LIFE_POTION:
				tile_index = OBJ_TILE_LIFE_POTION;
				break;
			case OBJ_TYPE_XP_SCROLL:
				tile_index = OBJ_TILE_XP_SCROLL;
				break;
			case OBJ_TYPE_SWORD:
				tile_index = OBJ_TILE_SWORD;
				break;
			case OBJ_TYPE_SWORD_BRONZE:
				tile_index = OBJ_TILE_SWORD_BRONZE;
				break;
			case OBJ_TYPE_SWORD_WOOD:
				tile_index = OBJ_TILE_SWORD_WOOD;
				break;
			default:
				/* KEY/DOOR/DOOR_VARIABLE/PLAYER_END: tile index == type */
				tile_index = objects[i].type;
				break;
		}
		tile = object_tile_for_type[tile_index];
		if (tile == 0) continue;
		idx = objects[i].y * 8 + objects[i].x;
		map_data[idx] = tile;
	}
}

/* Returns index of an active (not collected/opened) object at the
   given map position, or 0xFF if no object is there. */
static unsigned char find_object_at(unsigned char room, unsigned char x, unsigned char y) {
	unsigned char i;
	for (i = 0; i < object_count; i++) {
		if (objects[i].state & OBJECT_STATE_DONE) continue;
		if (objects[i].room == room &&
		    objects[i].x == x &&
		    objects[i].y == y) {
			return i;
		}
	}
	return 0xFF;
}

/* Apply the type-specific effect of stepping onto an object.
   Returns 1 if the player should move into the cell, 0 if blocked. */
static char handle_object_at(unsigned char idx) {
	object_t *obj = &objects[idx];
	unsigned char map_idx = obj->y * 8 + obj->x;

	switch (obj->type) {
		case OBJ_TYPE_KEY:
			obj->state |= OBJECT_STATE_DONE;
			if (player_keys < 255) player_keys++;
			map_data[map_idx] = OBJECT_FLOOR_TILE;
			is_map_data_dirty = 1;
			hud_dirty = 1;
			return 1;
		case OBJ_TYPE_DOOR:
			if (player_keys > 0) {
				player_keys--;
				obj->state |= OBJECT_STATE_DONE;
				map_data[map_idx] = OBJECT_FLOOR_TILE;
				is_map_data_dirty = 1;
				hud_dirty = 1;
				return 1;
			}
			return 0;
		case OBJ_TYPE_DOOR_VARIABLE:
			if (obj->variable_id != VAR_NONE && var_get(obj->variable_id)) {
				obj->state |= OBJECT_STATE_DONE;
				map_data[map_idx] = OBJECT_FLOOR_TILE;
				is_map_data_dirty = 1;
				return 1;
			}
			return 0;
		case OBJ_TYPE_PLAYER_END:
			/* End the game. If a per-room ending text exists, show it
			   in the dialog row and end after the dialog closes; else
			   end immediately. */
			if (obj->room < 9 && player_end_texts[obj->room][0]) {
				show_npc_dialog(player_end_texts[obj->room]);
				pending_ending = 1;
			} else {
				game_ended = 1;
			}
			return 1;
		case OBJ_TYPE_SWITCH:
			/* Toggle the OBJECT_STATE_ON bit and the linked variable.
			   The switch is walkable, so we always allow the move. */
			obj->state ^= OBJECT_STATE_ON;
			if (obj->state & OBJECT_STATE_ON) {
				map_data[map_idx] = object_tile_for_type[OBJ_TILE_SWITCH_ON];
				if (obj->variable_id != VAR_NONE) var_set(obj->variable_id);
			} else {
				map_data[map_idx] = object_tile_for_type[OBJ_TILE_SWITCH_OFF];
				if (obj->variable_id != VAR_NONE) var_clear(obj->variable_id);
			}
			is_map_data_dirty = 1;
			return 1;
		case OBJ_TYPE_LIFE_POTION:
			/* Collectible: pick up, increment lives, allow move. */
			obj->state |= OBJECT_STATE_DONE;
			if (player_lives < 255) player_lives++;
			map_data[map_idx] = OBJECT_FLOOR_TILE;
			is_map_data_dirty = 1;
			hud_dirty = 1;
			return 1;
		case OBJ_TYPE_XP_SCROLL:
			/* Collectible: pick up, increment XP, allow move. */
			obj->state |= OBJECT_STATE_DONE;
			if (player_xp < 255) player_xp++;
			map_data[map_idx] = OBJECT_FLOOR_TILE;
			is_map_data_dirty = 1;
			hud_dirty = 1;
			return 1;
		case OBJ_TYPE_SWORD:
		case OBJ_TYPE_SWORD_BRONZE:
		case OBJ_TYPE_SWORD_WOOD: {
			/* Only pick up a sword that's better than the current one
			   (priority: wood < bronze < sword). Worse swords are left
			   on the map, but the player can still walk onto them. */
			unsigned char new_pri = sword_priority(obj->type);
			unsigned char cur_pri = sword_priority(player_sword_type);
			if (new_pri > cur_pri) {
				obj->state |= OBJECT_STATE_DONE;
				player_sword_type       = obj->type;
				player_sword_durability = sword_durability_for(obj->type);
				map_data[map_idx] = OBJECT_FLOOR_TILE;
				is_map_data_dirty = 1;
				hud_dirty = 1;
			}
			return 1;
		}
	}
	return 1;
}

static void load_entities(void) {
	unsigned char i;
	unsigned char *p;
	resource_entry_format *e;

	npc_count = 0;
	dialog_active = 0;
	pending_reward_var = VAR_NONE;
	for (i = 0; i < (NUM_GAME_VARS / 8); i++) game_vars[i] = 0;
	world_cols = 3;
	world_rows = 3;

	/* Read world dimensions from project.inf first (independent of entities.dat) */
	{
		unsigned char *pinf;
		resource_entry_format *einf = resource_find("project.inf");
		if (einf && einf->size > 0) {
			pinf = (unsigned char *)resource_get_pointer(einf);
			if (pinf) {
				while (*pinf) pinf++; pinf++;
				while (*pinf) pinf++; pinf++;
				while (*pinf) pinf++; pinf++;
				if (pinf[0]) world_cols = pinf[0];
				if (pinf[1]) world_rows = pinf[1];
			}
		}
	}

	e = resource_find("entities.dat");
	if (!e || !e->size) return;
	p = (unsigned char *)resource_get_pointer(e);
	if (!p) return;
	npc_count = p[0];
	if (npc_count > MAX_NPCS) npc_count = MAX_NPCS;
	for (i = 0; i < npc_count; i++) {
		unsigned char *base = p + 1 + (unsigned int)i * NPC_ENTRY_LEN;
		npc_data[i].room        = base[0];
		npc_data[i].x           = base[1];
		npc_data[i].y           = base[2];
		npc_data[i].sprite_type = base[3];
		if (npc_data[i].room >= 9) npc_data[i].room = 0;
		if (npc_data[i].x >= 8)   npc_data[i].x    = 0;
		if (npc_data[i].y >= 8)   npc_data[i].y    = 0;
		if (npc_data[i].sprite_type >= MAX_NPC_SPRITE_TYPES)
			npc_data[i].sprite_type = 0;
		memcpy(npc_data[i].dialog,  (char *)(base + 4),                       NPC_DIALOG_LEN);
		memcpy(npc_data[i].dialog2, (char *)(base + 4 + NPC_DIALOG_LEN),      NPC_DIALOG_LEN);
		npc_data[i].dialog [NPC_DIALOG_LEN - 1] = 0;
		npc_data[i].dialog2[NPC_DIALOG_LEN - 1] = 0;
		npc_data[i].condition_var   = base[4 + 2 * NPC_DIALOG_LEN + 0];
		npc_data[i].reward_var      = base[4 + 2 * NPC_DIALOG_LEN + 1];
		npc_data[i].cond_reward_var = base[4 + 2 * NPC_DIALOG_LEN + 2];
		npc_actors[i].active = 0;
	}
}

static void draw_hud(void) {
	char buf[24];
	unsigned char i;
	const char *sword_name;
	/* Clear row 0 */
	for (i = 0; i < 32; i++) SMS_setTileatXY(i, 0, 0);
	/* Counters, left-aligned */
	SMS_setNextTileatXY(0, 0);
	sprintf(buf, "K:%d L:%d X:%d",
		(int)player_keys, (int)player_lives, (int)player_xp);
	puts(buf);
	/* Sword status, right-aligned */
	switch (player_sword_type) {
		case OBJ_TYPE_SWORD_WOOD:   sword_name = "Sw:Wd"; break;
		case OBJ_TYPE_SWORD_BRONZE: sword_name = "Sw:Br"; break;
		case OBJ_TYPE_SWORD:        sword_name = "Sw:Fe"; break;
		default:                    sword_name = "Sw:- "; break;
	}
	SMS_setNextTileatXY(32 - 5, 0);
	puts(sword_name);
	hud_dirty = 0;
}

static void show_npc_dialog(char *text) {
	unsigned char i;
	for (i = 0; i < 32; i++) SMS_setTileatXY(i, 21, 0);
	SMS_setNextTileatXY(0, 21);
	puts(text);
	dialog_active = 1;
}

/* Resolve which dialog text to show for NPC i (default vs conditional),
   set the pending reward variable, and display the chosen text. */
static void show_npc_dialog_for(unsigned char i) {
	unsigned char cv = npc_data[i].condition_var;
	char *text;
	if (cv != VAR_NONE && var_get(cv) && npc_data[i].dialog2[0]) {
		text = npc_data[i].dialog2;
		pending_reward_var = npc_data[i].cond_reward_var;
	} else {
		text = npc_data[i].dialog;
		pending_reward_var = npc_data[i].reward_var;
	}
	if (text[0]) show_npc_dialog(text);
}

static void close_npc_dialog(void) {
	unsigned char i;
	for (i = 0; i < 32; i++) SMS_setTileatXY(i, 21, 0);
	/* Award the variable that this dialog grants, if any */
	if (pending_reward_var != VAR_NONE) {
		var_set(pending_reward_var);
		pending_reward_var = VAR_NONE;
	}
	/* If this was an end-game dialog, finalize the ending now. */
	if (pending_ending) {
		game_ended = 1;
		pending_ending = 0;
	}
	dialog_active = 0;
}

static unsigned char find_npc_at(unsigned char room, unsigned char x, unsigned char y) {
	unsigned char i;
	for (i = 0; i < npc_count; i++) {
		if (npc_data[i].room == room && npc_data[i].x == x && npc_data[i].y == y)
			return (unsigned char)(i + 1);
	}
	return 0;
}

static void init_npc_actors(unsigned char room_idx) {
	unsigned char i;
	for (i = 0; i < npc_count; i++) {
		if (npc_data[i].room != room_idx) {
			npc_actors[i].active = 0;
			continue;
		}
		init_actor(&npc_actors[i],
			npc_data[i].x << 4,
			(npc_data[i].y << 4) + (MAP_SCREEN_Y << 3),
			2, 1,
			NPC_BASE_TILE(npc_data[i].sprite_type),
			2);
	}
}

/* Load the NPC sprite tiles for the given room into VRAM.
   The JS generator emits up to one "roomNN.spr" file per room, each containing
   up to MAX_NPC_SPRITE_TYPES sprite types × 16 sub-tiles × 32 bytes.
   Tiles are loaded at VRAM slot 24 (right after the player's 16 tiles at slots 8-23). */
static void load_room_sprites(unsigned char room_idx) {
	char fname[16];
	resource_entry_format *e;
	unsigned int size;
	void *ptr;
	sprintf(fname, "room%02d.spr", (int)(room_idx + 1));
	e = resource_find(fname);
	if (e && e->size > 0) {
		/* Cache fields from the resource entry BEFORE calling
		   resource_get_pointer — that call switches the ROM bank away
		   from RESOURCE_BANK, so any later read of e->field would return
		   garbage from a different bank. */
		size = e->size;
		ptr  = resource_get_pointer(e);
		SMS_loadTiles(ptr, 24, size);
	}
}


char gameplay_loop() {
	unsigned int joy = SMS_getKeysStatus();
	unsigned int joy_prev = 0;
	unsigned int joy_delay = 0;
	
	int map_number = 1;	
	
	/* Objects persist across rooms: load them once at game start and
	   reset the key inventory. State (collected/opened) is per-object
	   in RAM, so it survives room transitions naturally. */
	load_objects();
	load_endings();
	player_keys             = 0;
	player_lives            = 0;
	player_xp               = 0;
	player_sword_type       = 0;
	player_sword_durability = 0;
	game_ended              = 0;
	pending_ending          = 0;
	hud_dirty               = 1;
	
	while (1) {
		initialize_graphics();
		/* initialize_graphics wipes VRAM, so the HUD also needs redrawing
		   on every map setup (start of game + stage_clear-driven advance). */
		hud_dirty = 1;

		load_entities();
		{
		resource_entry_format *til_e = resource_find("main.til");
		if (til_e && til_e->size > 0) {
			SMS_loadTiles(resource_get_pointer(til_e), 4, til_e->size);
		}
	}
		
		tile_attrs = resource_find("main.atr");
		tile_combinations = resource_find("merging.dat");
		
		resource_map_format *map = load_map(map_number);
		if (!map) {
			map_number = 1;
			map = load_map(map_number);
		}
		prepare_map_data(map);

		SMS_displayOn();
		
		init_actor(&player, 32, 32, 2, 1, 8, 2);
		/* player_find_start scans the pristine map_data for the PLAYER_START
		   tile attribute. Apply objects AFTER it so an object placed at any
		   cell does not interfere with locating the start. */
		player_find_start(map);
		apply_objects_to_map((unsigned char)(map_number - 1));
		draw_map(map);

		load_room_sprites((unsigned char)(map_number - 1));
		init_npc_actors((unsigned char)(map_number - 1));
		/* ============================================================ */

		stage_clear = 0;
		is_map_data_dirty = 0;
		
		do {
			// Wait button press
			if (joy_delay) joy_delay--;
			if (!joy_delay || joy != joy_prev) {
				char ply_map_x = get_actor_map_x(&player);
				char ply_map_y = get_actor_map_y(&player);
				
				if (dialog_active) {
					if (joy) close_npc_dialog();
				} else {
					signed char _dx, _dy;
					unsigned char _room, _px, _py, _tx, _ty, _ni;
					_dx = 0; _dy = 0;
					if      (joy & PORT_A_KEY_UP)    _dy = -1;
					else if (joy & PORT_A_KEY_DOWN)  _dy =  1;
					else if (joy & PORT_A_KEY_LEFT)  _dx = -1;
					else if (joy & PORT_A_KEY_RIGHT) _dx =  1;
					if (_dx || _dy) {
						_room = (unsigned char)(map_number - 1);
						_px = (unsigned char)get_actor_map_x(&player);
						_py = (unsigned char)get_actor_map_y(&player);
						_tx = (unsigned char)(_px + _dx);
						_ty = (unsigned char)(_py + _dy);
						_ni = find_npc_at(_room, _tx, _ty);
						if (_ni) {
							show_npc_dialog_for((unsigned char)(_ni - 1));
						} else {
							/* Object interaction takes priority over both edge
							   crossing and try_moving_actor_on_map: the player
							   may try to step onto an in-room object even at
							   the edge cells (x=7 / y=7), and we want the
							   key/door/end logic to fire there instead of
							   sending the player to the neighbour room. */
							unsigned char _oi = find_object_at(_room, _tx, _ty);
							if (_oi != 0xFF) {
								if (handle_object_at(_oi)) {
									set_actor_map_xy(&player, _tx, _ty);
								}
							} else if (_tx >= 8 || _ty >= 8) {
								/* Edge crossing: compute neighbour room */
								unsigned char cur_room = (unsigned char)(map_number - 1);
								unsigned char cur_row  = cur_room / world_cols;
								unsigned char cur_col  = cur_room % world_cols;
								char nb_row = (char)cur_row, nb_col = (char)cur_col;
								unsigned char wrap_x = _px, wrap_y = _py;
								if (_dx < 0) { nb_col--; wrap_x = 7; }
								if (_dx > 0) { nb_col++; wrap_x = 0; }
								if (_dy < 0) { nb_row--; wrap_y = 7; }
								if (_dy > 0) { nb_row++; wrap_y = 0; }
								/* Debug: store nb_row, nb_col into npc index slot for inspection */
								/* Cast nb_row/nb_col to unsigned for the bounds check since SDCC treats char as unsigned */
								if ((unsigned char)nb_row < world_rows && (unsigned char)nb_col < world_cols) {
									/* Valid neighbour: transition to it */
									map_number = (unsigned char)nb_row * world_cols + (unsigned char)nb_col + 1;
									map = load_map(map_number);
									if (map) {
										prepare_map_data(map);
										apply_objects_to_map((unsigned char)(map_number - 1));
										set_actor_map_xy(&player, wrap_x, wrap_y);
										load_room_sprites((unsigned char)(map_number - 1));
										init_npc_actors((unsigned char)(map_number - 1));
										is_map_data_dirty = 1;
									}
								}
								/* (if no neighbour, player stays — same as TRS clamping) */
							} else {
								try_moving_actor_on_map(&player, map, _dx, _dy);
							}
						}
					}
				}
				
				joy_delay = 8;
			}
			
			SMS_initSprites();
			draw_actor(&player);
			{
				unsigned char _i;
				for (_i = 0; _i < npc_count; _i++) {
					if (npc_data[_i].room == (unsigned char)(map_number - 1))
						draw_actor(&npc_actors[_i]);
				}
			}
			SMS_finalizeSprites();	
			
						SMS_waitForVBlank();
			SMS_copySpritestoSAT();
			/* Draw map during VBlank if dirty (guaranteed safe VRAM write window) */
			if (is_map_data_dirty) {
				resource_map_format *cur_map = load_map(map_number);
				if (cur_map) draw_map(cur_map);
				is_map_data_dirty = 0;
			}
			if (hud_dirty) draw_hud();
			
			joy_prev = joy;
			joy = SMS_getKeysStatus();
		} while (!stage_clear && !game_ended);
		
		if (game_ended) break;
		
		map_number++;

		wait_button_release();
	}

	return STATE_GAMEOVER;
}

char handle_gameover() {
	initialize_graphics();

	SMS_setNextTileatXY(12, 11);
	puts("THE END");

	SMS_setNextTileatXY(7, 14);
	puts("Press any button");

	SMS_displayOn();

	wait_button_press();
	wait_button_release();

	return STATE_START;
}

char handle_title() {
	initialize_graphics();
	
	char *app_name = resource_get_pointer(resource_find("project.inf"));
	char *app_version = skip_after_end_of_string(app_name);
	char *project_name = skip_after_end_of_string(app_version);
	
	SMS_setNextTileatXY(2, 1);
	printf("%s %s", app_name, app_version);

	SMS_setNextTileatXY(2, 3);
	puts(project_name);

	SMS_setNextTileatXY(2, 21);
	puts("Press any button to start");
	
	SMS_displayOn();
	
	wait_button_press();
	wait_button_release();
	
	return STATE_GAMEPLAY;
}

void main() {
	char state = STATE_START;
	
	SMS_useFirstHalfTilesforSprites(1);
	SMS_setSpriteMode(SPRITEMODE_TALL);
	
	while (1) {
		switch (state) {
			
		case STATE_START:
			state = handle_title();
			break;
			
		case STATE_GAMEPLAY:
			state = gameplay_loop();
			break;
			
		case STATE_GAMEOVER:
			state = handle_gameover();
			break;
		}
	}
}

SMS_EMBED_SEGA_ROM_HEADER(9999,0); // code 9999 hopefully free, here this means 'homebrew'
SMS_EMBED_SDSC_HEADER(0,6, 2025,03,18, "Haroldo-OK\\2025", "SMS-Puzzle-Maker base ROM",
  "Made for SMS-Puzzle-Maker - https://github.com/haroldo-ok/SMS-Puzzle-Maker.\n"
  "Built using devkitSMS & SMSlib - https://github.com/sverx/devkitSMS");
