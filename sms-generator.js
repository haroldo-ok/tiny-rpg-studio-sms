<script>
/* ============================================================
   SMS RPG Studio — ROM Generator

   VRAM layout (SMS_loadTiles at slot 4, first-half for sprites):
     Slot  4- 7 : BG tile 0        (tileNumber 1)
     Slot  8-23 : Player sprite     (tileNumbers 2-5, reserved)
     Slot 24-39 : NPC sprite type 0 (tileNumbers 6-9, reserved)
     Slot 40-55 : NPC sprite type 1 (tileNumbers 10-13, reserved)
     Slot 56-71 : NPC sprite type 2 (tileNumbers 14-17, reserved)
     Slot 72-87 : NPC sprite type 3 (tileNumbers 18-21, reserved)
     Slot 88+   : BG tile 1,2,…    (tileNumber = bgIdx + 21)

   entities.dat:
     byte 0: npc_count
     per NPC (4 bytes): room, x, y, sprite_type

   bgIdxToNum(i): i==0 → 1; i>=1 → i+21
   ============================================================ */
(function() {
'use strict';

const BASE_ROM_B64 = "BASE_ROM_PLACEHOLDER";

const N_NPC_SPRITE_TYPES = 4; // must match MAX_NPC_SPRITE_TYPES in C

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
    if (pad !== undefined) { while (arr.length < pad) arr.push(0); return arr.slice(0, pad); }
    return arr;
}
function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }

function hexToSmsByte(hex) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    const q = v => v < 43 ? 0 : v < 128 ? 1 : v < 213 ? 2 : 3;
    return q(r) | (q(g) << 2) | (q(b) << 4);
}

function encodeSMSTile(pixels, palette) {
    const bytes = [];
    for (let row = 0; row < 8; row++) {
        const planes = [0,0,0,0];
        for (let col = 0; col < 8; col++) {
            const c = (pixels[row] && pixels[row][col]) || 'transparent';
            let idx = 0;
            if (c && c !== 'transparent') {
                const norm = c.toLowerCase().trim();
                for (let p = 0; p < palette.length; p++)
                    if (palette[p] && palette[p].toLowerCase().trim() === norm) { idx = p; break; }
            }
            const bit = 0x80 >> col;
            for (let pl = 0; pl < 4; pl++) if (idx & (1 << pl)) planes[pl] |= bit;
        }
        bytes.push(...planes);
    }
    return bytes;
}

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

function scale2x(g) {
    const out = [];
    for (const row of g) { const d = row.flatMap(px => [px,px]); out.push(d,[...d]); }
    return out;
}
function quad(g, r0, c0) { return g.slice(r0,r0+8).map(r => r.slice(c0,c0+8)); }
function mirrorH(g) { return g.map(r => [...r].reverse()); }

// Encode one 8x8 BG tile → 4 SMS sub-tiles, 128 bytes (TL,BL,TR,BR order)
function encodeBGTile(pixels, palette) {
    const big = scale2x(pixels);
    return [
        ...encodeSMSTile(quad(big,0,0), palette),
        ...encodeSMSTile(quad(big,8,0), palette),
        ...encodeSMSTile(quad(big,0,8), palette),
        ...encodeSMSTile(quad(big,8,8), palette),
    ];
}

// Encode one 8x8 palette-index sprite → 16 SMS sprite tiles (4 frames), 512 bytes
function buildSpriteFrames(sp8) {
    const bigL = scale2x(sp8), bigR = scale2x(mirrorH(sp8));
    const tiles = [];
    for (let f = 0; f < 2; f++)
        for (const q of [quad(bigL,0,0),quad(bigL,8,0),quad(bigL,0,8),quad(bigL,8,8)])
            tiles.push(...encodeIndexTile(q));
    for (let f = 0; f < 2; f++)
        for (const q of [quad(bigR,0,0),quad(bigR,8,0),quad(bigR,0,8),quad(bigR,8,8)])
            tiles.push(...encodeIndexTile(q));
    return tiles; // 512 bytes
}

// BG tile index → 1-based tileNumber
// Slots 4-7=BG0(tileNum1), 8-23=player(2-5), 24-87=4 NPC types(6-21), 88+=BG1+(22+)
function bgIdxToNum(i) { return i === 0 ? 1 : i + 21; }

// Resource filesystem builder (mirrors SMS-Puzzle-Maker game-resource.js exactly)
function buildResourceFS(files) {
    const PAGE = 16384, ENTRY = 20;
    files = files.slice().sort((a,b) => a.name < b.name ? -1 : 1);
    const hdr = [...strBytes('rsc',4), ...u16(files.length)];
    const initOff = hdr.length + files.length * ENTRY;
    let page = 2, off = initOff;
    const alloc = files.map(f => {
        if (off + f.content.length > PAGE) { page++; off = 0; }
        const e = {name:f.name, page, off, content:f.content};
        off += f.content.length; return e;
    });
    const tbl = alloc.flatMap(a => [...strBytes(a.name,14),...u16(a.page),...u16(a.content.length),...u16(a.off)]);
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
    el.style.display = 'block'; el.style.color = color || '#8af'; el.innerHTML = msg;
}

// Default player sprite (8x8 palette indices)
const PLAYER_SP = [
    [null,null, 1,  1,  1,  1, null,null],
    [null, 1,  15, 15, 15, 15,  1, null],
    [ 1,   6,  15, 12, 15, 12,  1, null],
    [ 1,   6,  15, 15, 15, 15,  1, null],
    [ 1,   9,   9,  4,  4,  9,  9,  1 ],
    [ 1,  15,   9,  9,  9,  4, 15,  1 ],
    [null, 1,   5,  5,  5,  5,  1, null],
    [null, 1,   5,  1,  1,  5,  1, null]
];

// NPC sprite matrices keyed by TRS type name (palette indices, 8x8)
const NPC_SPRITES = {default:[[null,null,null,5,5,5,null,null],[null,null,5,5,5,5,5,null],[null,null,7,1,7,1,7,null],[5,null,7,7,7,7,7,null],[5,null,5,5,5,5,5,null],[5,7,6,5,5,5,6,null],[5,null,6,6,5,6,6,null],[5,null,6,6,6,6,6,null]],"old-mage":[[null,1,1,1,1,1,null,null],[1,4,6,6,6,6,1,null],[1,4,15,12,15,12,1,null],[1,4,15,15,15,15,5,1],[1,15,5,6,6,6,15,1],[1,4,5,6,6,6,1,null],[1,4,5,5,6,6,1,null],[1,4,5,5,5,5,1,null]],"villager-man":[[null,null,1,1,1,1,null,null],[null,1,15,15,15,15,1,null],[1,6,15,12,15,12,1,null],[1,6,15,15,15,15,1,null],[1,9,9,4,4,9,9,1],[1,15,9,9,9,4,15,1],[null,1,5,5,5,5,1,null],[null,1,5,1,1,5,1,null]],"villager-woman":[[null,null,1,1,1,1,null,null],[null,1,15,15,15,15,1,null],[1,14,15,12,15,12,1,null],[1,14,15,15,15,15,1,null],[1,14,14,8,8,14,14,1],[1,15,14,14,14,8,15,1],[null,1,8,8,8,8,1,null],[null,1,8,1,1,8,1,null]],child:[[null,null,1,1,1,null,null,null],[null,1,15,15,15,1,null,null],[1,6,15,12,15,1,null,null],[1,6,15,15,15,1,null,null],[1,9,9,4,9,9,1,null],[1,15,9,9,4,15,1,null],[null,1,5,5,5,1,null,null],[null,1,5,1,5,1,null,null]],king:[[null,10,10,10,10,null,null,null],[null,10,15,15,10,null,null,null],[10,10,15,12,15,10,null,null],[10,10,15,15,15,10,null,null],[10,10,9,4,9,10,10,null],[10,15,10,9,4,15,10,null],[null,10,10,10,10,10,null,null],[null,10,10,1,10,10,null,null]],knight:[[null,null,5,5,5,5,null,null],[null,5,5,15,15,5,5,null],[5,5,15,12,15,12,5,null],[5,5,15,15,15,15,5,null],[5,5,5,4,4,5,5,5],[5,15,5,5,5,4,15,5],[null,5,5,5,5,5,5,null],[null,5,5,1,1,5,5,null]],thief:[[null,null,13,13,13,null,null,null],[null,13,15,15,15,13,null,null],[13,1,15,12,15,1,13,null],[13,1,15,15,15,15,1,null],[13,1,9,4,4,9,1,13],[13,15,1,9,9,4,15,13],[null,13,1,9,9,1,13,null],[null,13,1,13,13,1,13,null]],blacksmith:[[null,null,5,5,5,5,null,null],[null,5,15,15,15,15,5,null],[5,4,15,12,15,12,4,null],[5,4,15,15,15,15,5,null],[5,4,4,9,9,4,4,5],[5,15,4,9,9,9,15,5],[null,5,9,9,9,9,5,null],[null,5,9,1,1,9,5,null]],"wooden-sign":[[null,null,1,1,1,1,null,null],[null,1,10,10,10,10,1,null],[null,1,10,10,10,10,1,null],[null,1,10,10,10,10,1,null],[null,1,1,1,1,1,1,null],[null,null,null,1,null,null,null,null],[null,null,null,1,null,null,null,null],[null,null,null,1,null,null,null,null]],"thought-bubble":[[null,null,1,1,1,null,null,null],[null,1,7,7,7,1,null,null],[1,7,7,7,7,7,1,null],[1,7,7,7,7,7,1,null],[1,7,7,7,7,7,1,null],[null,1,1,1,1,1,null,null],[null,null,null,1,null,null,null,null],[null,null,1,null,null,null,null,null]]};
// Elf and dwarf variants fall back to human equivalents
function getNpcSprite(type) {
    if (NPC_SPRITES[type]) return NPC_SPRITES[type];
    // strip -elf / -dwarf suffix and try base type
    const base = type.replace(/-(elf|dwarf)$/, '');
    return NPC_SPRITES[base] || NPC_SPRITES['default'];
}

async function generateSMSRom() {
    const btn = document.getElementById('btn-generate-sms-rom');
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');
    try {
        const api = window.TinyRPGMaker;
        if (!api) throw new Error('Engine not ready — please wait and try again.');

        const gameData = api.exportGameData();
        if (!gameData) throw new Error('No game data.');
        const title = (gameData.title || 'My SMS RPG').slice(0, 32);

        /* ── Palette ── */
        const DEFAULT_PAL = ['#000000','#1D2B53','#7E2553','#008751',
            '#AB5236','#5F574F','#C2C3C7','#FFF1E8',
            '#FF004D','#FFA300','#FFFF27','#00E756',
            '#29ADFF','#83769C','#FF77A8','#FFCCAA'];
        const palette = (Array.isArray(gameData.customPalette) && gameData.customPalette.length === 16)
            ? gameData.customPalette : DEFAULT_PAL;
        const palBytes = palette.map(hexToSmsByte);

        /* ── NPC types ──
           Collect the unique NPC types used, capped at N_NPC_SPRITE_TYPES.
           Build a sprite_type index (0-3) for each NPC.
        */
        setStatus('Collecting NPC types…', '#8af');
        const allNpcs = Array.isArray(gameData.sprites) ? gameData.sprites : [];
        const placedNpcs = allNpcs.filter(n => n.placed !== false);

        // Map NPC type string → sprite_type index (0..N_NPC_SPRITE_TYPES-1)
        const typeToIdx = new Map();
        for (const npc of placedNpcs) {
            const t = npc.type || 'default';
            if (!typeToIdx.has(t) && typeToIdx.size < N_NPC_SPRITE_TYPES)
                typeToIdx.set(t, typeToIdx.size);
        }

        /* ── BG tiles ── */
        setStatus('Encoding tiles…', '#8af');
        const liveTiles = api.getTiles();
        if (!Array.isArray(liveTiles) || !liveTiles.length) throw new Error('No tiles found.');
        const idToIdx = new Map();
        liveTiles.forEach((t,i) => idToIdx.set(String(t.id), i));

        function getTilePx(t) {
            return (t && t.pixels && t.pixels.length === 8) ? t.pixels
                : Array.from({length:8}, () => Array(8).fill(palette[0]));
        }

        /* ── Build main.til ──
           Layout: BG0 | player | NPC-type-0..3 (all 4 always) | BG1 | BG2 | …
           We always emit all 4 NPC type slots so the C code's base_tile
           calculations are always correct regardless of how many types are used.
        */
        const tileBuf = [];
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[0]), palette)); // BG tile 0, tileNum 1
        tileBuf.push(...buildSpriteFrames(PLAYER_SP));                    // player, tileNums 2-5
        for (let t = 0; t < N_NPC_SPRITE_TYPES; t++) {                   // NPC types 0-3
            // Find the NPC type assigned to this slot (if any)
            let spriteName = 'default';
            for (const [k,v] of typeToIdx) { if (v === t) { spriteName = k; break; } }
            tileBuf.push(...buildSpriteFrames(getNpcSprite(spriteName)));  // tileNums 6-9, 10-13, …
        }
        for (let i = 1; i < liveTiles.length; i++)
            tileBuf.push(...encodeBGTile(getTilePx(liveTiles[i]), palette)); // BG tile 1+

        /* ── Tile attributes ──
           attrBuf[tileNumber-1] = 16-bit attribute word.
           Indices 0: BG tile 0, indices 1-4: player reserved, indices 5-20: NPC reserved,
           index 21+i-1 (i>=1): BG tile i.
        */
        const maxTileNum = bgIdxToNum(liveTiles.length - 1);
        const attrBuf = new Array((maxTileNum + 1) * 2).fill(0);
        liveTiles.forEach((t, i) => {
            const tn = bgIdxToNum(i);
            const attr = t.collision ? 0x0001 : 0;
            attrBuf[(tn-1)*2] = attr & 0xFF; attrBuf[(tn-1)*2+1] = (attr>>8) & 0xFF;
        });

        /* ── Player start ── */
        let startRoom = 0, startX = 1, startY = 1;
        try {
            const gd = api.exportGameData();
            if (gd && gd.start) {
                startRoom = (gd.start.roomIndex || 0) & 0xFF;
                startX    = (gd.start.x || 1) & 0xFF;
                startY    = (gd.start.y || 1) & 0xFF;
            }
        } catch(e) {}

        /* ── Start marker tile (TILE_ATTR_PLAYER_START) ──
           Same pixels as the ground tile at start position.
           Placed in the map at the player's starting cell.
        */
        const startTileNum = maxTileNum + 1;
        // BUG WORKAROUND: api.getTileMap() doesn't forward roomIndex; read maps directly.
        const tilesetMaps = (gameData.tileset && Array.isArray(gameData.tileset.maps))
            ? gameData.tileset.maps : [];
        const startTm = tilesetMaps[startRoom] || null;
        const startGround = startTm && startTm.ground;
        const startTid = (startGround && startGround[startY] && startGround[startY][startX] != null)
            ? startGround[startY][startX] : null;
        const startBgIdx = (startTid != null && idToIdx.has(String(startTid)))
            ? idToIdx.get(String(startTid)) : 0;
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[startBgIdx]), palette));
        // Set TILE_ATTR_PLAYER_START (0x0002)
        while (attrBuf.length < (startTileNum) * 2) attrBuf.push(0);
        attrBuf[(startTileNum-1)*2]   = 0x02;
        attrBuf[(startTileNum-1)*2+1] = 0x00;

        /* ── Maps ── */
        setStatus('Encoding maps…', '#8af');
        const mapFiles = [];
        for (let r = 0; r < 9; r++) {
            const tm = tilesetMaps[r] || null;
            const ground  = (tm && tm.ground)  || [];
            const overlay = (tm && tm.overlay) || [];
            const bytes = [];
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    if (r === startRoom && col === startX && row === startY) {
                        bytes.push(startTileNum); continue;
                    }
                    const ov = overlay[row] && overlay[row][col];
                    const gr = ground[row]  && ground[row][col];
                    const tid = (ov != null) ? ov : (gr != null) ? gr : null;
                    const idx = (tid != null && idToIdx.has(String(tid)))
                        ? idToIdx.get(String(tid)) : 0;
                    bytes.push(bgIdxToNum(idx));
                }
            }
            mapFiles.push({ name:`level${String(r+1).padStart(3,'0')}.map`,
                content:[...u16(r+1),...u16(8),...u16(8),...strBytes(`Room ${r+1}`,32),...bytes] });
        }

        /* ── entities.dat ──
           byte 0: npc_count
           per NPC: room(1) x(1) y(1) sprite_type(1)
        */
        setStatus('Building entity data…', '#8af');
        // entities.dat: byte 0 = npc_count, then per NPC: room(1)+x(1)+y(1)+sprite_type(1)+dialog[36]
        const NPC_DIALOG_LEN = 36;
        const entBuf = [Math.min(placedNpcs.length, 31)];
        for (let i = 0; i < Math.min(placedNpcs.length, 31); i++) {
            const npc = placedNpcs[i];
            const t   = npc.type || 'default';
            const si  = typeToIdx.has(t) ? typeToIdx.get(t) : 0;
            // Dialog text: use npc.text, truncated to 35 chars
            const rawText = (npc.text || '').slice(0, NPC_DIALOG_LEN - 1);
            const dialogBytes = new Array(NPC_DIALOG_LEN).fill(0);
            for (let c = 0; c < rawText.length; c++)
                dialogBytes[c] = rawText.charCodeAt(c) & 0xFF;
            entBuf.push(
                (npc.roomIndex || 0) & 0xFF,
                (npc.x || 0) & 0xFF,
                (npc.y || 0) & 0xFF,
                si & 0xFF,
                ...dialogBytes
            );
        }

        /* ── project.inf / merging.dat ── */
        const worldCols = (gameData.world && gameData.world.cols) ? Math.max(1, gameData.world.cols) : 3;
        const worldRows = (gameData.world && gameData.world.rows) ? Math.max(1, gameData.world.rows) : 3;
        const projInfo = [...strBytes('SMS-RPG-Studio'),...strBytes('1.0'),...strBytes(title),
            worldCols & 0xFF, worldRows & 0xFF];
        const totalTN = startTileNum;
        const combos = [...u16(totalTN), ...new Array(totalTN * totalTN).fill(0)];

        /* ── Assemble resource filesystem ── */
        setStatus('Building resource filesystem…', '#8af');
        const files = [
            { name:'main.pal',    content:Array.from(palBytes) },
            { name:'main.til',    content:tileBuf },
            { name:'main.atr',    content:attrBuf },
            { name:'entities.dat',content:entBuf },
            { name:'project.inf', content:projInfo },
            { name:'merging.dat', content:combos },
            ...mapFiles
        ];
        const resourceData = buildResourceFS(files);

        /* ── Assemble ROM ── */
        const baseRom = b64ToBytes(BASE_ROM_B64);
        const rom = new Uint8Array(baseRom.length + resourceData.length);
        rom.set(baseRom);
        resourceData.forEach((b,i) => { rom[baseRom.length+i] = b; });

        const kb = Math.ceil(rom.length / 1024);
        const safeTitle = title.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'my-tiny-rpg';
        const filename = `${safeTitle}.sms`;

        let bin = '';
        for (let i = 0; i < rom.length; i++) bin += String.fromCharCode(rom[i]);
        const dataUrl = 'data:application/octet-stream;base64,' + btoa(bin);
        const a = document.createElement('a');
        a.href = dataUrl; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();

        const nTypes = typeToIdx.size;
        setStatus(
            `✓ ${kb} KB · ${liveTiles.length} tiles · ${placedNpcs.length} NPCs` +
            ` (${nTypes} type${nTypes!==1?'s':''}) · start: room ${startRoom+1} (${startX},${startY})`,
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
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSmsButton);
else wireSmsButton();

})();
</script>
