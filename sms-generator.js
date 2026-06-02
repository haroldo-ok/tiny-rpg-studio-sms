<script>
/* ============================================================
   SMS ROM GENERATOR for Tiny RPG Studio
   
   TILE NUMBERING (draw_tile uses tileNumber << 2 as SMS slot):
     tileNumber 1 → SMS slots  4- 7  = BG tile index 0
     tileNumber 2 → SMS slots  8-11  = player sprite frame 0-L  (reserved)
     tileNumber 3 → SMS slots 12-15  = player sprite frame 1-L  (reserved)
     tileNumber 4 → SMS slots 16-19  = player sprite frame 0-R  (reserved)
     tileNumber 5 → SMS slots 20-23  = player sprite frame 1-R  (reserved)
     tileNumber 6 → SMS slots 24-27  = BG tile index 1
     tileNumber 7 → SMS slots 28-31  = BG tile index 2
     ...
     tileNumber N+5 → start-marker tile (same pixels as tile 0, PLAYER_START flag)
   
   Map cell encoding:
     BG tile index 0  → tileNumber 1
     BG tile index i≥1 → tileNumber i+5
     Player start cell → tileNumber N+5 (N = liveTiles.length)
   
   main.til sub-tile order for each BG tile (matches draw_tile in C):
     offset 0:  top-left 8×8
     offset 32: bottom-left 8×8
     offset 64: top-right 8×8
     offset 96: bottom-right 8×8
   
   Player sprite: 8×8 editor sprite scaled 2× to 16×16, split into
   4 quadrants per frame (TL,BL,TR,BR), 4 frames = 16 SMS tiles = 512 bytes.
   ============================================================ */
(function() {
'use strict';

const BASE_ROM_B64 = "BASE_ROM_PLACEHOLDER";

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

function hexToSmsByte(hex) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2), 16);
    const g = parseInt(hex.slice(2,4), 16);
    const b = parseInt(hex.slice(4,6), 16);
    const q = v => v < 43 ? 0 : v < 128 ? 1 : v < 213 ? 2 : 3;
    return q(r) | (q(g) << 2) | (q(b) << 4);
}

// Encode 8×8 grid of hex color strings into 32-byte SMS 4-bitplane tile
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

// Encode 8×8 grid of palette indices (number|null) into 32-byte SMS tile
function encodeIndexTile(pixels) {
    const bytes = [];
    for (let row = 0; row < 8; row++) {
        const planes = [0,0,0,0];
        for (let col = 0; col < 8; col++) {
            const v = pixels[row] && pixels[row][col];
            const idx = (v != null) ? v : 0;
            const bit = 0x80 >> col;
            for (let pl = 0; pl < 4; pl++) if (idx & (1 << pl)) planes[pl] |= bit;
        }
        bytes.push(...planes);
    }
    return bytes;
}

// Scale 8×8 grid to 16×16 by 2× pixel doubling
function scale2x(g) {
    const out = [];
    for (const row of g) {
        const d = row.flatMap(px => [px, px]);
        out.push(d, [...d]);
    }
    return out;
}

// Extract 8×8 sub-grid from 16×16
function quad(g, r0, c0) {
    return g.slice(r0, r0+8).map(r => r.slice(c0, c0+8));
}

// Mirror grid horizontally
function mirrorH(g) { return g.map(r => [...r].reverse()); }

// Encode one 8×8 game tile as 4 SMS sub-tiles (128 bytes)
// Order: TL, BL, TR, BR  (matches draw_tile() in puzzle_maker_base_rom.c)
function encodeBGTile(pixels, palette) {
    const big = scale2x(pixels);
    return [
        ...encodeSMSTile(quad(big,0,0), palette),  // top-left
        ...encodeSMSTile(quad(big,8,0), palette),  // bottom-left
        ...encodeSMSTile(quad(big,0,8), palette),  // top-right
        ...encodeSMSTile(quad(big,8,8), palette),  // bottom-right
    ];
}

// Build 16 SMS sprite tiles from an 8×8 palette-index sprite (512 bytes)
// Frames: [frame0-left, frame1-left, frame0-right, frame1-right]
// Each frame: 4 sub-tiles in TL, BL, TR, BR order
function buildPlayerSpriteTiles(sp8) {
    const bigL = scale2x(sp8);
    const bigR = scale2x(mirrorH(sp8));
    const tiles = [];
    for (let f = 0; f < 2; f++) {  // 2 frames facing left (same image, slight wobble)
        for (const q of [quad(bigL,0,0), quad(bigL,8,0), quad(bigL,0,8), quad(bigL,8,8)])
            tiles.push(...encodeIndexTile(q));
    }
    for (let f = 0; f < 2; f++) {  // 2 frames facing right (mirrored)
        for (const q of [quad(bigR,0,0), quad(bigR,8,0), quad(bigR,0,8), quad(bigR,8,8)])
            tiles.push(...encodeIndexTile(q));
    }
    return tiles; // 16 × 32 = 512 bytes
}

// Convert game tile index to 1-based tileNumber used in map cells
// Accounts for 4 player sprite slots at tileNumbers 2-5
function tileIdxToNum(idx) {
    return idx === 0 ? 1 : idx + 5;
}

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

async function generateSMSRom() {
    const btn = document.getElementById('btn-generate-sms-rom');
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');

    try {
        const api = window.TinyRPGMaker;
        if (!api) throw new Error('Engine not ready — please wait a moment and try again.');

        const gameData = api.exportGameData();
        const title = (gameData && gameData.title || 'my-tiny-rpg').slice(0, 32);

        /* --- Palette (16 SMS 6-bit bytes) --- */
        const DEFAULT_PAL = [
            '#000000','#1D2B53','#7E2553','#008751',
            '#AB5236','#5F574F','#C2C3C7','#FFF1E8',
            '#FF004D','#FFA300','#FFFF27','#00E756',
            '#29ADFF','#83769C','#FF77A8','#FFCCAA'
        ];
        const palette = (Array.isArray(gameData && gameData.customPalette) && gameData.customPalette.length === 16)
            ? gameData.customPalette : DEFAULT_PAL;
        const palBytes = palette.map(hexToSmsByte);

        /* --- BG tiles --- */
        setStatus('Encoding tiles…', '#8af');
        const liveTiles = api.getTiles();
        if (!Array.isArray(liveTiles) || !liveTiles.length) throw new Error('No tiles found.');

        const idToIdx = new Map();
        liveTiles.forEach((t,i) => idToIdx.set(String(t.id), i));

        // Get pixel grids (fall back to solid colour if missing)
        function getTilePixels(t) {
            return (t && t.pixels && t.pixels.length === 8) ? t.pixels
                : Array.from({length:8}, () => Array(8).fill(palette[0]));
        }

        /* --- Player sprite --- */
        const DEFAULT_PLAYER = [
            [null,null, 1,  1,  1,  1, null,null],
            [null, 1,  15, 15, 15, 15,  1, null],
            [ 1,   6,  15, 12, 15, 12,  1, null],
            [ 1,   6,  15, 15, 15, 15,  1, null],
            [ 1,   9,   9,  4,  4,  9,  9,  1 ],
            [ 1,  15,   9,  9,  9,  4, 15,  1 ],
            [null, 1,   5,  5,  5,  5,  1, null],
            [null, 1,   5,  1,  1,  5,  1, null]
        ];
        let playerSprite = DEFAULT_PLAYER;
        try {
            // Try to read the actual player sprite from the running game state
            const st = api.getState();
            const m = st && st.player && st.player.spriteMatrix;
            if (m && Array.isArray(m) && m.length === 8 && m[0].length === 8) playerSprite = m;
        } catch(e) {}

        const playerTiles = buildPlayerSpriteTiles(playerSprite); // 512 bytes

        /* --- Build main.til ---
           Layout: [BG tile 0 (128 B)] [player (512 B)] [BG tile 1 (128 B)] [BG tile 2 (128 B)] ...
        */
        const tileBuf = [];
        tileBuf.push(...encodeBGTile(getTilePixels(liveTiles[0]), palette)); // tileNumber 1
        tileBuf.push(...playerTiles);                                          // tileNumbers 2-5
        for (let i = 1; i < liveTiles.length; i++) {
            tileBuf.push(...encodeBGTile(getTilePixels(liveTiles[i]), palette)); // tileNumber i+5
        }
        // Start-marker tile: same pixels as tile 0, gets PLAYER_START attr
        tileBuf.push(...encodeBGTile(getTilePixels(liveTiles[0]), palette)); // tileNumber N+5

        /* --- Tile attributes ---
           attrBuf is 1-indexed by tileNumber.
           Slots for player frames (tileNumbers 2-5) get attr=0.
           BG tile i≥1 is at tileNumber i+5, so attrBuf index i+4.
           Start-marker tile is at tileNumber N+5, attrBuf index N+4.
           Total entries: liveTiles.length + 5 (tile0, 4 player slots, tile1..N, start marker)
        */
        const N = liveTiles.length;
        const attrCount = N + 5; // tileNumbers 1 through N+5
        const attrBuf = new Array(attrCount).fill(0).flatMap(() => u16(0));

        // Set BG tile attributes
        liveTiles.forEach((t, i) => {
            const attrIdx = (i === 0) ? 0 : (i + 4); // tileNumber-1
            let attr = 0;
            if (t.collision) attr |= 0x0001; // SOLID
            attrBuf[attrIdx * 2]     = attr & 0xFF;
            attrBuf[attrIdx * 2 + 1] = (attr >> 8) & 0xFF;
        });

        // Set PLAYER_START flag on start-marker tile (tileNumber N+5, index N+4)
        const startMarkerAttrIdx = N + 4;
        attrBuf[startMarkerAttrIdx * 2]     = 0x02; // TILE_ATTR_PLAYER_START
        attrBuf[startMarkerAttrIdx * 2 + 1] = 0x00;

        /* --- Maps --- */
        setStatus('Encoding maps…', '#8af');

        // Get player start position
        let startRoom = 0, startX = 0, startY = 0;
        try {
            const gd = api.exportGameData();
            if (gd && gd.start) {
                startRoom = gd.start.roomIndex || 0;
                startX    = gd.start.x || 0;
                startY    = gd.start.y || 0;
            }
        } catch(e) {}

        const startTileNum = N + 5; // 1-based tileNumber for the start marker

        const mapFiles = [];
        for (let r = 0; r < 9; r++) {
            const tm = api.getTileMap(r);
            const ground  = (tm && tm.ground)  || [];
            const overlay = (tm && tm.overlay) || [];
            const bytes = [];
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    // Mark player start cell with the start-marker tileNumber
                    if (r === startRoom && col === startX && row === startY) {
                        bytes.push(startTileNum);
                        continue;
                    }
                    const ov = overlay[row] && overlay[row][col];
                    const gr = ground[row]  && ground[row][col];
                    const tid = (ov != null) ? ov : (gr != null) ? gr : null;
                    const idx = (tid != null && idToIdx.has(String(tid)))
                        ? idToIdx.get(String(tid)) : 0;
                    bytes.push(tileIdxToNum(idx));
                }
            }
            const content = [
                ...u16(r+1), ...u16(8), ...u16(8),
                ...strBytes(`Room ${r+1}`, 32),
                ...bytes
            ];
            mapFiles.push({ name: `level${String(r+1).padStart(3,'0')}.map`, content });
        }

        /* --- project.inf, merging.dat --- */
        const projInfo = [
            ...strBytes('SMS-RPG-Studio'),
            ...strBytes('1.0'),
            ...strBytes(title)
        ];
        const totalTiles = N + 5;
        const combos = [...u16(totalTiles), ...new Array(totalTiles * totalTiles).fill(0)];

        /* --- Assemble and download --- */
        setStatus('Building resource filesystem…', '#8af');
        const resourceData = buildResourceFS([
            { name: 'main.pal',    content: Array.from(palBytes) },
            { name: 'main.til',    content: tileBuf },
            { name: 'main.atr',    content: Array.from(attrBuf) },
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
            .replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-zA-Z0-9]+/g,'-')
            .replace(/^-+|-+$/g,'')
            .toLowerCase() || 'my-tiny-rpg';
        const filename = `${safeTitle}.sms`;

        let bin = '';
        for (let i = 0; i < rom.length; i++) bin += String.fromCharCode(rom[i]);
        const dataUrl = 'data:application/octet-stream;base64,' + btoa(bin);

        const a = document.createElement('a');
        a.href = dataUrl; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();

        setStatus(
            `✓ ROM ready — ${kb} KB · ${N} tiles · player start: room ${startRoom+1} (${startX},${startY})`,
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
