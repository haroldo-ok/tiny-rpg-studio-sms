<script>
/* ============================================================
   SMS RPG Studio — ROM Generator
   Mirrors Tiny RPG Studio's game model exactly on SMS hardware.

   Resource files produced:
     main.pal     — 16 SMS 6-bit palette bytes
     main.til     — BG + sprite tiles in SMS 4-bitplane format
     main.atr     — tile collision attributes (u16 per tile)
     entities.dat — player start, NPCs, enemies, exits
     sprites.dat  — sprite type → VRAM base tile mapping
     project.inf  — title/author strings
     merging.dat  — tile combination table (all zeros)
     level001–009.map — 9 room tilemaps

   main.til VRAM layout (SMS_loadTiles at slot 4):
     Slot  4- 7 : BG tile 0 (sub-tiles TL,BL,TR,BR)
     Slot  8-23 : Player sprite (4 frames × 4 sub-tiles = 16 SMS tiles)
     Slot 24-39 : NPC/enemy sprite 0  (16 SMS tiles)
     Slot 40-55 : NPC/enemy sprite 1
     ... (one slot block of 16 per unique sprite type)
     Then BG tiles 1,2,… (4 sub-tiles each)

   entities.dat binary layout:
     start_room(u8) start_x(u8) start_y(u8)
     npc_count(u8) [ room x y sprite_idx dialog[128] ] × npc_count
     enemy_count(u8) [ room x y sprite_idx lives damage ] × enemy_count
     exit_count(u8) [ room x y target_room target_x target_y ] × exit_count

   sprites.dat binary layout:
     sprite_count(u8) [ name[16] base_tile(u8) ] × sprite_count
   ============================================================ */
(function() {
'use strict';

const BASE_ROM_B64 = "BASE_ROM_PLACEHOLDER";

/* ── Helpers ───────────────────────────────────────────────── */
function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function strBytes(s, pad) {
    const arr = [];
    for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i) & 0xFF);
    arr.push(0);
    if (pad !== undefined) {
        while (arr.length < pad) arr.push(0);
        return arr.slice(0, pad);
    }
    return arr;
}

function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
function u8(n)  { return [n & 0xFF]; }

/* ── SMS palette ───────────────────────────────────────────── */
function hexToSmsByte(hex) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    const q = v => v < 43 ? 0 : v < 128 ? 1 : v < 213 ? 2 : 3;
    return q(r) | (q(g) << 2) | (q(b) << 4);
}

/* ── SMS tile encoding ─────────────────────────────────────── */
// Encode 8×8 hex-color grid → 32-byte 4-bitplane SMS tile
function encodeSMSTile(pixels, palette) {
    const bytes = [];
    for (let row = 0; row < 8; row++) {
        const planes = [0,0,0,0];
        for (let col = 0; col < 8; col++) {
            const c = (pixels[row] && pixels[row][col]) || 'transparent';
            let idx = 0;
            if (c && c !== 'transparent') {
                const norm = c.toLowerCase().trim();
                for (let p = 0; p < palette.length; p++) {
                    if (palette[p] && palette[p].toLowerCase().trim() === norm) { idx = p; break; }
                }
            }
            const bit = 0x80 >> col;
            for (let pl = 0; pl < 4; pl++) if (idx & (1 << pl)) planes[pl] |= bit;
        }
        bytes.push(...planes);
    }
    return bytes;
}

// Encode 8×8 palette-index grid (number|null) → 32-byte SMS tile
function encodeIndexTile(pixels) {
    const bytes = [];
    for (let row = 0; row < 8; row++) {
        const planes = [0,0,0,0];
        for (let col = 0; col < 8; col++) {
            const v = pixels[row] != null ? pixels[row][col] : null;
            const idx = (v != null) ? v : 0;
            const bit = 0x80 >> col;
            for (let pl = 0; pl < 4; pl++) if (idx & (1 << pl)) planes[pl] |= bit;
        }
        bytes.push(...planes);
    }
    return bytes;
}

// Scale 8×8 grid → 16×16 (2× pixel doubling)
function scale2x(g) {
    const out = [];
    for (const row of g) {
        const d = row.flatMap(px => [px, px]);
        out.push(d, [...d]);
    }
    return out;
}

// Extract 8×8 quadrant from 16×16 grid
function quad(g, r0, c0) {
    return g.slice(r0, r0+8).map(r => r.slice(c0, c0+8));
}

// Mirror grid horizontally
function mirrorH(g) { return g.map(r => [...r].reverse()); }

// Encode one 8×8 BG tile → 4 SMS sub-tiles (128 bytes)
// Order: TL, BL, TR, BR  (matches draw_tile() in C ROM)
function encodeBGTile(pixels, palette) {
    const big = scale2x(pixels);
    return [
        ...encodeSMSTile(quad(big,0,0), palette),
        ...encodeSMSTile(quad(big,8,0), palette),
        ...encodeSMSTile(quad(big,0,8), palette),
        ...encodeSMSTile(quad(big,8,8), palette),
    ];
}

// Encode 8×8 palette-index sprite → 4 SMS sub-tiles (128 bytes, scaled 2×)
// Quadrant order for SPRITEMODE_TALL 2×1 actor: TL, BL, TR, BR
function encodeSpriteTile(sp8) {
    const big = scale2x(sp8);
    return [
        ...encodeIndexTile(quad(big,0,0)),
        ...encodeIndexTile(quad(big,8,0)),
        ...encodeIndexTile(quad(big,0,8)),
        ...encodeIndexTile(quad(big,8,8)),
    ];
}

// Build 4 animation frames for a sprite (facing-left × 2 + facing-right × 2)
// Each frame = 4 sub-tiles × 32 bytes = 128 bytes
// Total = 16 SMS tiles = 512 bytes
function buildSpriteFrames(sp8) {
    const bigL = scale2x(sp8);
    const bigR = scale2x(mirrorH(sp8));
    const tiles = [];
    for (let f = 0; f < 2; f++) {
        for (const q of [quad(bigL,0,0), quad(bigL,8,0), quad(bigL,0,8), quad(bigL,8,8)])
            tiles.push(...encodeIndexTile(q));
    }
    for (let f = 0; f < 2; f++) {
        for (const q of [quad(bigR,0,0), quad(bigR,8,0), quad(bigR,0,8), quad(bigR,8,8)])
            tiles.push(...encodeIndexTile(q));
    }
    return tiles; // 512 bytes
}

/* ── Map tile number mapping ───────────────────────────────── */
// BG tile index → tileNumber used in map cells (1-based for the C ROM)
// Accounts for player sprite (4 tileNumbers) + N sprite types (4 tileNumbers each)
// at slots after tile 0, before tile 1.
// Layout: tile0(1) | player(2-5) | sprite0(6-9) | sprite1(10-13) | ... | tile1(6+4N) | tile2 ...
function bgIdxToTileNum(bgIdx, spriteTypeCount) {
    const reservedAfterTile0 = 1 + 4 * spriteTypeCount; // player + all NPC/enemy sprite types
    if (bgIdx === 0) return 1;
    return bgIdx + reservedAfterTile0;
}

/* ── Resource filesystem ───────────────────────────────────── */
function buildResourceFS(files) {
    const PAGE = 16384, ENTRY = 20;
    files = files.slice().sort((a,b) => a.name < b.name ? -1 : 1);
    const hdr = [...strBytes('rsc',4), ...u16(files.length)];
    const initOff = hdr.length + files.length * ENTRY;
    let page = 2, off = initOff;
    const alloc = files.map(f => {
        if (off + f.content.length > PAGE) { page++; off = 0; }
        const e = {name:f.name, page, off, content:f.content};
        off += f.content.length;
        return e;
    });
    const tbl = alloc.flatMap(a => [
        ...strBytes(a.name,14), ...u16(a.page),
        ...u16(a.content.length), ...u16(a.off)
    ]);
    const pages = [new Array(PAGE).fill(0)];
    [...hdr,...tbl].forEach((b,i) => { pages[0][i] = b; });
    alloc.forEach(a => {
        const pi = a.page - 2;
        while (pages.length <= pi) pages.push(new Array(PAGE).fill(0));
        a.content.forEach((b,i) => { pages[pi][a.off+i] = b; });
    });
    return pages.flat();
}

function setStatus(msg, color) {
    const el = document.getElementById('sms-rom-status');
    if (!el) return;
    el.style.display = 'block';
    el.style.color = color || '#8af';
    el.innerHTML = msg;
}

/* ── Default sprites ───────────────────────────────────────── */
const DEFAULT_PLAYER_SP = [
    [null,null, 1,  1,  1,  1, null,null],
    [null, 1,  15, 15, 15, 15,  1, null],
    [ 1,   6,  15, 12, 15, 12,  1, null],
    [ 1,   6,  15, 15, 15, 15,  1, null],
    [ 1,   9,   9,  4,  4,  9,  9,  1 ],
    [ 1,  15,   9,  9,  9,  4, 15,  1 ],
    [null, 1,   5,  5,  5,  5,  1, null],
    [null, 1,   5,  1,  1,  5,  1, null]
];

const DEFAULT_NPC_SP = [
    [null,null,null, 5,  5,  5, null,null],
    [null,null, 5,   5,  5,  5,  5, null],
    [null,null, 7,   1,  7,  1,  7, null],
    [ 5, null,  7,   7,  7,  7,  7, null],
    [ 5, null,  5,   5,  5,  5,  5, null],
    [ 5,  7,    6,   5,  5,  5,  6, null],
    [ 5, null,  6,   6,  5,  6,  6, null],
    [ 5, null,  6,   6,  6,  6,  6, null]
];

const DEFAULT_ENEMY_SP = [
    [null,null, 6, null,null,null, 6, null],
    [null,null, 6,  6,  6,  6,  6, null],
    [null,null, 6,  6,  8,  6,  8, null],
    [null,null, 6,  6,  6,  6,  6, null],
    [null,null, 1,  1,  6,  1,  1, null],
    [null,null, 6,  1,  1,  1,  6, null],
    [null,null,null, 1,  1,  1, null,null],
    [null,null,null, 6, null, 6, null,null]
];

/* ── Main generator ────────────────────────────────────────── */
async function generateSMSRom() {
    const btn = document.getElementById('btn-generate-sms-rom');
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');

    try {
        const api = window.TinyRPGMaker;
        if (!api) throw new Error('Engine not ready — please wait a moment and try again.');

        const gameData = api.exportGameData();
        if (!gameData) throw new Error('No game data.');
        const title = (gameData.title || 'My SMS RPG').slice(0, 32);

        /* ── Palette ── */
        const DEFAULT_PAL = [
            '#000000','#1D2B53','#7E2553','#008751',
            '#AB5236','#5F574F','#C2C3C7','#FFF1E8',
            '#FF004D','#FFA300','#FFFF27','#00E756',
            '#29ADFF','#83769C','#FF77A8','#FFCCAA'
        ];
        const palette = (Array.isArray(gameData.customPalette) && gameData.customPalette.length === 16)
            ? gameData.customPalette : DEFAULT_PAL;
        const palBytes = palette.map(hexToSmsByte);

        /* ── Collect unique sprite types needed ── */
        setStatus('Collecting sprites…', '#8af');

        // Gather all NPC and enemy types referenced
        const npcs    = Array.isArray(gameData.sprites)  ? gameData.sprites  : [];
        const enemies = Array.isArray(gameData.enemies)  ? gameData.enemies  : [];
        const exits   = Array.isArray(gameData.exits)    ? gameData.exits    : [];
        const start   = gameData.start || { x:1, y:1, roomIndex:0 };

        // Build ordered list of unique sprite types (NPC types first, then enemy types)
        // We need the sprite pixel data for each. We'll look them up from the live tiles API.
        // TRS sprite data is: npc.type → NpcSpriteMatrices[type], enemy.type → EnemySpriteMatrices[type]
        // We can't import those modules here, so we embed the common ones and fall back to defaults.

        const NPC_SPRITES = {
            'default':        DEFAULT_NPC_SP,
            'old-mage': [[null,1,1,1,1,1,null,null],[1,4,6,6,6,6,1,null],[1,4,15,12,15,12,1,null],[1,4,15,15,15,15,5,1],[1,15,5,6,6,6,15,1],[1,4,5,6,6,6,1,null],[1,4,5,5,6,6,1,null],[1,4,5,5,5,5,1,null]],
            'common-man':  DEFAULT_NPC_SP,
            'common-woman':DEFAULT_NPC_SP,
            'curious-child':DEFAULT_NPC_SP,
            'king':       [[null,1,1,1,1,1,null,null],[1,10,10,10,10,10,1,null],[1,10,15,12,15,12,1,null],[1,10,15,15,15,15,5,1],[1,15,9,9,9,9,15,1],[1,10,9,9,9,9,1,null],[1,10,9,9,9,9,1,null],[1,10,9,10,9,9,1,null]],
            'knight':     [[null,1,1,1,1,1,null,null],[1,5,5,5,5,5,1,null],[1,5,15,12,15,12,1,null],[1,5,15,15,15,15,5,1],[1,15,5,5,5,5,15,1],[1,5,5,5,5,5,1,null],[1,5,5,5,5,5,1,null],[1,5,5,1,5,5,1,null]],
        };

        const ENEMY_SPRITES = {
            'default':       DEFAULT_ENEMY_SP,
            'giant-rat':  [[null,1,15,15,1,15,15,1],[null,1,15,15,1,15,15,1],[1,15,13,13,13,13,13,1],[1,15,13,8,13,8,13,1],[1,15,5,13,13,13,1,null],[1,5,5,5,15,1,null,null],[1,5,5,5,5,1,null,null],[1,15,1,1,15,1,null,null]],
            'bandit':     [[null,1,1,1,1,1,6,1],[1,15,15,15,15,1,7,1],[1,15,8,15,8,1,7,1],[1,4,4,4,4,5,6,1],[1,5,4,4,4,2,2,2],[1,5,5,4,5,1,4,1],[1,13,13,13,13,1,1,null],[1,13,1,1,13,1,null,null]],
            'skeleton':   [[null,1,1,null,1,1,null,null],[null,1,15,1,15,1,null,null],[null,null,15,15,15,null,null,null],[null,1,15,15,15,1,null,null],[null,null,1,1,1,null,null,null],[null,1,null,1,null,1,null,null],[null,1,null,1,null,1,null,null],[null,null,null,null,null,null,null,null]],
            'dark-knight':[[null,1,1,1,1,null,1,null],[1,5,5,5,5,1,2,1],[1,5,8,5,8,1,2,1],[1,5,13,5,13,5,2,1],[1,13,5,13,5,14,14,1],[1,5,13,5,13,1,5,1],[1,5,5,13,5,1,1,null],[1,5,1,1,5,1,null,null]],
            'dragon':     [[null,1,1,1,1,1,1,null],[1,3,11,11,11,11,11,1],[1,11,11,11,8,11,8,1],[1,3,3,11,11,11,11,1],[1,11,3,11,7,1,7,1],[1,11,11,11,11,3,1,null],[1,11,11,11,11,1,1,null],[1,11,1,1,11,1,null,null]],
        };

        // Collect unique sprite type keys in order of appearance
        const spriteTypeKeys = []; // ['npc:old-mage', 'enemy:giant-rat', ...]
        const spriteTypeMap  = new Map(); // key → { group, type, pixels }

        function addSpriteType(group, type) {
            const key = `${group}:${type}`;
            if (!spriteTypeMap.has(key)) {
                const registry = group === 'npc' ? NPC_SPRITES : ENEMY_SPRITES;
                const pixels = registry[type] || registry['default'];
                spriteTypeMap.set(key, { group, type, pixels });
                spriteTypeKeys.push(key);
            }
            return spriteTypeKeys.indexOf(key);
        }

        // Map NPCs and enemies to sprite indices
        const npcSpriteIdx    = npcs.map(npc => addSpriteType('npc', npc.type || 'default'));
        const enemySpriteIdx  = enemies.map(en => addSpriteType('enemy', en.type || 'default'));

        const spriteTypeCount = spriteTypeKeys.length;

        /* ── Build main.til ── */
        setStatus('Encoding tiles…', '#8af');
        const liveTiles = api.getTiles();
        if (!Array.isArray(liveTiles) || !liveTiles.length) throw new Error('No tiles found.');

        const idToIdx = new Map();
        liveTiles.forEach((t,i) => idToIdx.set(String(t.id), i));

        function getTilePx(t) {
            return (t && t.pixels && t.pixels.length === 8) ? t.pixels
                : Array.from({length:8}, () => Array(8).fill(palette[0]));
        }

        // VRAM slot layout:
        //   slot 4        : BG tile 0 (4 sub-tiles)
        //   slots 8-23    : player (16 SMS tiles)
        //   slots 24-24+16*N-1 : sprite types (16 SMS tiles each)
        //   slots after   : BG tile 1, 2, … (4 sub-tiles each)
        const playerTiles      = buildSpriteFrames(DEFAULT_PLAYER_SP); // 512 bytes
        const spriteTypeTiles  = spriteTypeKeys.map(k => buildSpriteFrames(spriteTypeMap.get(k).pixels));

        // Player base tile: SMS slot 8
        // Sprite type i base tile: SMS slot 8 + 16 + i*16 = 24 + i*16
        // BG tiles start after all sprite data: slot 4+4 + 16 + spriteTypeCount*16 = 24 + spriteTypeCount*16
        // But we load starting at slot 4, so within main.til:
        //   byte 0:   BG tile 0  (4 sub-tiles × 32 = 128 bytes)
        //   byte 128: player     (16 SMS tiles × 32 = 512 bytes)
        //   byte 640: sprite type 0 (512 bytes)
        //   ...
        //   byte 640 + spriteTypeCount*512: BG tile 1

        const tileBuf = [];
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[0]), palette)); // BG tile 0
        tileBuf.push(...playerTiles);                                     // player
        for (const sp of spriteTypeTiles) tileBuf.push(...sp);            // sprite types
        for (let i = 1; i < liveTiles.length; i++) {
            tileBuf.push(...encodeBGTile(getTilePx(liveTiles[i]), palette)); // BG tiles 1..N
        }

        /* ── Tile attributes ── */
        // tileNumber 1 → BG tile 0 attr at attrBuf[0]
        // tileNumbers 2..1+4*(1+spriteTypeCount) → reserved for player+sprites → attr = 0
        // tileNumber for BG tile i≥1 → attrBuf[bgIdxToTileNum(i,spriteTypeCount)-1]
        const reservedCount = 1 + spriteTypeCount; // player slot-block + each sprite type slot-block (each 4 tileNumbers)
        const totalTileNums = bgIdxToTileNum(liveTiles.length - 1, spriteTypeCount) + 1;
        const attrBuf = new Array(totalTileNums * 2).fill(0);

        liveTiles.forEach((t, i) => {
            const tn = bgIdxToTileNum(i, spriteTypeCount);
            const attr = t.collision ? 0x0001 : 0;
            attrBuf[(tn-1)*2]   = attr & 0xFF;
            attrBuf[(tn-1)*2+1] = (attr >> 8) & 0xFF;
        });

        /* ── Map encoding ── */
        setStatus('Encoding maps…', '#8af');
        const mapFiles = [];
        for (let r = 0; r < 9; r++) {
            const tm = api.getTileMap(r);
            const ground  = (tm && tm.ground)  || [];
            const overlay = (tm && tm.overlay) || [];
            const bytes = [];
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    const ov  = overlay[row] && overlay[row][col];
                    const gr  = ground[row]  && ground[row][col];
                    const tid = (ov != null)  ? ov : (gr != null) ? gr : null;
                    const idx = (tid != null && idToIdx.has(String(tid)))
                                ? idToIdx.get(String(tid)) : 0;
                    bytes.push(bgIdxToTileNum(idx, spriteTypeCount));
                }
            }
            // Room name from gameData.rooms
            const roomDef = (gameData.rooms && gameData.rooms[r]);
            const roomName = `Room ${r+1}`;
            const content = [
                ...u16(r+1), ...u16(8), ...u16(8),
                ...strBytes(roomName, 32),
                ...bytes
            ];
            mapFiles.push({ name: `level${String(r+1).padStart(3,'0')}.map`, content });
        }

        /* ── entities.dat ── */
        setStatus('Building entities…', '#8af');
        const entBuf = [];
        entBuf.push(start.roomIndex & 0xFF, start.x & 0xFF, start.y & 0xFF);

        // NPCs (only placed ones)
        const placedNpcs = npcs.filter(n => n.placed !== false && n.placed !== undefined ? n.placed : true);
        entBuf.push(Math.min(placedNpcs.length, 32));
        for (let i = 0; i < Math.min(placedNpcs.length, 32); i++) {
            const npc = placedNpcs[i];
            const si  = npcSpriteIdx[npcs.indexOf(npc)] || 0;
            entBuf.push(
                (npc.roomIndex || 0) & 0xFF,
                (npc.x || 0) & 0xFF,
                (npc.y || 0) & 0xFF,
                si & 0xFF
            );
            // Dialog text: 128 bytes, null-terminated
            const dialog = (npc.text || npc.name || '').slice(0, 127);
            const dialogBytes = new Array(128).fill(0);
            for (let c = 0; c < dialog.length; c++) dialogBytes[c] = dialog.charCodeAt(c) & 0xFF;
            entBuf.push(...dialogBytes);
        }

        // Enemies
        entBuf.push(Math.min(enemies.length, 32));
        for (let i = 0; i < Math.min(enemies.length, 32); i++) {
            const en = enemies[i];
            const si = enemySpriteIdx[i] || 0;
            entBuf.push(
                (en.roomIndex || 0) & 0xFF,
                (en.x || 0) & 0xFF,
                (en.y || 0) & 0xFF,
                si & 0xFF,
                1, // lives (enemies.lives not available at design time)
                1  // damage
            );
        }

        // Exits (from gameData.exits)
        entBuf.push(Math.min(exits.length, 32));
        for (let i = 0; i < Math.min(exits.length, 32); i++) {
            const ex = exits[i];
            entBuf.push(
                (ex.roomIndex || 0)  & 0xFF,
                (ex.x || 0) & 0xFF,
                (ex.y || 0) & 0xFF,
                (ex.targetRoomIndex || 0) & 0xFF,
                (ex.targetX || 0) & 0xFF,
                (ex.targetY || 0) & 0xFF
            );
        }

        /* ── sprites.dat ── */
        // base_tile for player = 8 (absolute SMS slot)
        // base_tile for sprite type i = 24 + i*16 (SMS slot relative to slot 4, so subtract 4)
        // But ROM uses SMS_loadTiles offset, so base_tile = absolute SMS slot
        // player: slot 8 → base_tile 8
        // sprite type 0: slot 24 → base_tile 24
        // sprite type 1: slot 40 → base_tile 40
        const spriteDat = [spriteTypeCount & 0xFF];
        for (let i = 0; i < spriteTypeCount; i++) {
            const key = spriteTypeKeys[i];
            const name = key.slice(0, 15); // max 15 chars + null
            const nameBytes = new Array(16).fill(0);
            for (let c = 0; c < Math.min(name.length, 15); c++) nameBytes[c] = name.charCodeAt(c) & 0xFF;
            const baseTile = 24 + i * 16; // SMS slot
            spriteDat.push(...nameBytes, baseTile & 0xFF);
        }

        /* ── project.inf ── */
        const projInfo = [
            ...strBytes('SMS-RPG-Studio'),
            ...strBytes('1.0'),
            ...strBytes(title)
        ];

        /* ── merging.dat ── */
        const totalBGTileNums = bgIdxToTileNum(liveTiles.length - 1, spriteTypeCount);
        const combos = [...u16(totalBGTileNums), ...new Array(totalBGTileNums * totalBGTileNums).fill(0)];

        /* ── Assemble ROM ── */
        setStatus('Assembling ROM…', '#8af');
        const resourceData = buildResourceFS([
            { name: 'main.pal',    content: Array.from(palBytes) },
            { name: 'main.til',    content: tileBuf },
            { name: 'main.atr',    content: attrBuf },
            { name: 'entities.dat',content: entBuf },
            { name: 'sprites.dat', content: spriteDat },
            { name: 'project.inf', content: projInfo },
            { name: 'merging.dat', content: combos },
            ...mapFiles
        ]);

        const baseRom = b64ToBytes(BASE_ROM_B64);
        const rom = new Uint8Array(baseRom.length + resourceData.length);
        rom.set(baseRom);
        resourceData.forEach((b,i) => { rom[baseRom.length + i] = b; });

        const kb = Math.ceil(rom.length / 1024);
        const safeTitle = title.normalize('NFD')
            .replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-')
            .replace(/^-+|-+$/g,'').toLowerCase() || 'my-tiny-rpg';
        const filename = `${safeTitle}.sms`;

        let bin = '';
        for (let i = 0; i < rom.length; i++) bin += String.fromCharCode(rom[i]);
        const dataUrl = 'data:application/octet-stream;base64,' + btoa(bin);
        const a = document.createElement('a');
        a.href = dataUrl; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();

        setStatus(
            `✓ ${kb} KB · ${liveTiles.length} tiles · ${spriteTypeCount} sprite types · ` +
            `${placedNpcs.length} NPCs · ${enemies.length} enemies · ` +
            `start: room ${(start.roomIndex||0)+1} (${start.x||0},${start.y||0})`,
            '#4f8'
        );

    } catch(err) {
        console.error('[SMS ROM Export]', err);
        setStatus('Error: ' + err.message, '#f88');
    } finally {
        btn.disabled = false;
    }
}

function wireSmsButton() {
    const btn = document.getElementById('btn-generate-sms-rom');
    if (btn) btn.addEventListener('click', generateSMSRom);
    else setTimeout(wireSmsButton, 500);
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', wireSmsButton);
else
    wireSmsButton();

})();
</script>
