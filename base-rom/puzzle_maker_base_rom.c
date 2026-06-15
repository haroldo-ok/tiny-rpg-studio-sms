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
	return data + (y * map->width) + x;
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
	memcpy(map_data, map->tiles, map->height * map->width);
	memcpy(map_floor, 0, map->height * map->width);
}

void draw_map(resource_map_format *map) {
	char *o = map_data;
	for (char y = 0; y != map->height; y++) {
		for (char x = 0; x != map->width; x++) {
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
	if (new_x >= map->width || new_y >= map->height) return 0;

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
	if (new_x >= map->width || new_y >= map->height) return;
	
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
	char *o = map->tiles;
	for (char y = 0; y != map->height; y++) {
		for (char x = 0; x != map->width; x++) {
			unsigned int tile_attr = get_tile_attr(*o);
			if (tile_attr & TILE_ATTR_PLAYER_START) {
				set_actor_map_xy(&player, x, y);
			}
			o++;
		}
	}
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
	sprintf(fname, "room%02d.spr", (int)(room_idx + 1));
	e = resource_find(fname);
	if (e && e->size > 0) {
		SMS_loadTiles(resource_get_pointer(e), 24, e->size);
	}
}


char gameplay_loop() {
	unsigned int joy = SMS_getKeysStatus();
	unsigned int joy_prev = 0;
	unsigned int joy_delay = 0;
	
	int map_number = 1;	
	
	while (1) {
		initialize_graphics();

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
		draw_map(map);

		SMS_displayOn();
		
		init_actor(&player, 32, 32, 2, 1, 8, 2);
		player_find_start(map);
		load_room_sprites((unsigned char)(map_number - 1));
		init_npc_actors((unsigned char)(map_number - 1));

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
							/* Check for world edge crossing (TRS MovementManager logic) */
							/* Use constant room size (always 8x8 in TRS) — avoids bank-mapping issues */
							if (_tx >= 8 || _ty >= 8) {
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
			
			joy_prev = joy;
			joy = SMS_getKeysStatus();
		} while (!stage_clear);
		
		map_number++;

		wait_button_release();
	}

	return STATE_GAMEOVER;
}

char handle_gameover() {
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
