<script>
/* ============================================================
   SMS RPG Studio — ROM Generator
   Based on SMS-Puzzle-Maker's resource format exactly.

   main.til VRAM layout (SMS_loadTiles at slot 4):
     Slot  4- 7 : BG tile index 0  (4 sub-tiles TL,BL,TR,BR)
     Slot  8-23 : Player sprite    (16 SMS tiles, 4 frames)
     Slot 24+   : BG tile index 1, 2, … (4 sub-tiles each)

   tileNumber mapping in map cells (matches draw_tile: sms = tileNumber<<2):
     tileNumber 1 → slot 4  = BG tile 0
     tileNumbers 2-5        = player sprite (reserved, never in BG map)
     tileNumber 6 → slot 24 = BG tile 1
     tileNumber 7 → slot 28 = BG tile 2  …etc.

   Player start: placed via TILE_ATTR_PLAYER_START on a dedicated
   tile at the start position. The tile has the same pixels as
   the floor tile there but carries the start flag in main.atr.
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

// Encode one 8×8 BG tile → 4 SMS sub-tiles 128 bytes (TL,BL,TR,BR = draw_tile order)
function encodeBGTile(pixels, palette) {
    const big = scale2x(pixels);
    return [
        ...encodeSMSTile(quad(big,0,0), palette),
        ...encodeSMSTile(quad(big,8,0), palette),
        ...encodeSMSTile(quad(big,0,8), palette),
        ...encodeSMSTile(quad(big,8,8), palette),
    ];
}

// Build 16 sprite SMS tiles (4 frames × 4 sub-tiles) = 512 bytes
function buildSpriteFrames(sp8) {
    const bigL = scale2x(sp8), bigR = scale2x(mirrorH(sp8));
    const tiles = [];
    for (let f = 0; f < 2; f++)
        for (const q of [quad(bigL,0,0),quad(bigL,8,0),quad(bigL,0,8),quad(bigL,8,8)])
            tiles.push(...encodeIndexTile(q));
    for (let f = 0; f < 2; f++)
        for (const q of [quad(bigR,0,0),quad(bigR,8,0),quad(bigR,0,8),quad(bigR,8,8)])
            tiles.push(...encodeIndexTile(q));
    return tiles;
}

// BG tile index → 1-based tileNumber (skips 4 player sprite slots after tile 0)
function bgIdxToNum(idx) { return idx === 0 ? 1 : idx + 5; }

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

async function generateSMSRom() {
    const btn = document.getElementById('btn-generate-sms-rom');
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');
    try {
        const api = window.TinyRPGMaker;
        if (!api) throw new Error('Engine not ready — please wait and try again.');

        const gameData = api.exportGameData();
        if (!gameData) throw new Error('No game data.');
        const title = (gameData.title || 'My SMS RPG').slice(0,32);

        /* ── Palette ── */
        const DEFAULT_PAL = ['#000000','#1D2B53','#7E2553','#008751',
            '#AB5236','#5F574F','#C2C3C7','#FFF1E8',
            '#FF004D','#FFA300','#FFFF27','#00E756',
            '#29ADFF','#83769C','#FF77A8','#FFCCAA'];
        const palette = (Array.isArray(gameData.customPalette) && gameData.customPalette.length === 16)
            ? gameData.customPalette : DEFAULT_PAL;
        const palBytes = palette.map(hexToSmsByte);

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

        /* ── main.til ──
           [BG tile 0: 128 B][player: 512 B][BG tile 1,2,…: 128 B each][start tile: 128 B]
           tileNumber 1 → BG tile 0
           tileNumbers 2-5 → player frames (reserved)
           tileNumber i+5 → BG tile i (i≥1)
           tileNumber N+5 → start marker tile (same pixels as floor at start pos)
        */
        const playerTiles = buildSpriteFrames(DEFAULT_PLAYER);
        const tileBuf = [];
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[0]), palette)); // tileNum 1
        tileBuf.push(...playerTiles);                                      // tileNums 2-5
        for (let i = 1; i < liveTiles.length; i++)
            tileBuf.push(...encodeBGTile(getTilePx(liveTiles[i]), palette)); // tileNum i+5

        /* ── Player start position ── */
        let startRoom = 0, startX = 1, startY = 1;
        try {
            const gd = api.exportGameData();
            if (gd && gd.start) {
                startRoom = gd.start.roomIndex || 0;
                startX    = gd.start.x || 1;
                startY    = gd.start.y || 1;
            }
        } catch(e) {}

        /* Start marker tile: same pixels as ground at start position, gets PLAYER_START attr.
           We use tileNumber N+5 where N = liveTiles.length. */
        const N = liveTiles.length;
        const startTileNum = N + 5;

        // Get the ground tile at the start position for the start marker appearance
        const startTm = api.getTileMap(startRoom);
        const startGround = startTm && startTm.ground;
        const startTid = (startGround && startGround[startY] && startGround[startY][startX] != null)
            ? startGround[startY][startX] : null;
        const startBgIdx = (startTid != null && idToIdx.has(String(startTid)))
            ? idToIdx.get(String(startTid)) : 0;
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[startBgIdx]), palette)); // start tile

        /* ── Tile attributes ── */
        // attrBuf indexed by tileNumber-1
        // Slots 0: BG tile 0
        // Slots 1-4: player frames (attr=0)
        // Slot i+4 (i≥1): BG tile i
        // Slot N+4: start marker (PLAYER_START = 0x0002)
        const attrCount = N + 5; // tileNumbers 1..N+5
        const attrBuf = new Array(attrCount * 2).fill(0);
        liveTiles.forEach((t, i) => {
            const attrIdx = (i === 0) ? 0 : (i + 4);
            const attr = t.collision ? 0x0001 : 0;
            attrBuf[attrIdx*2] = attr & 0xFF; attrBuf[attrIdx*2+1] = (attr>>8) & 0xFF;
        });
        // PLAYER_START flag on start marker
        attrBuf[(N+4)*2] = 0x02; attrBuf[(N+4)*2+1] = 0x00;

        /* ── Maps ── */
        setStatus('Encoding maps…', '#8af');
        const mapFiles = [];
        for (let r = 0; r < 9; r++) {
            const tm = api.getTileMap(r);
            const ground  = (tm && tm.ground)  || [];
            const overlay = (tm && tm.overlay) || [];
            const bytes = [];
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    // Player start cell → start marker tile
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

        /* ── project.inf / merging.dat ── */
        const projInfo = [...strBytes('SMS-RPG-Studio'),...strBytes('1.0'),...strBytes(title)];
        const totalTN = startTileNum; // highest tileNumber used
        const combos = [...u16(totalTN), ...new Array(totalTN * totalTN).fill(0)];

        /* ── Resource filesystem ── */
        setStatus('Building resource filesystem…', '#8af');
        const resourceData = buildResourceFS([
            { name:'main.pal',    content:Array.from(palBytes) },
            { name:'main.til',    content:tileBuf },
            { name:'main.atr',    content:attrBuf },
            { name:'project.inf', content:projInfo },
            { name:'merging.dat', content:combos },
            ...mapFiles
        ]);

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

        setStatus(`✓ ${kb} KB · ${N} tiles · player start: room ${startRoom+1} (${startX},${startY})`, '#4f8');
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
