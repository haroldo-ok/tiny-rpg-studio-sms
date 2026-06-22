<script>
/* ============================================================
   SMS RPG Studio — ROM Generator

   VRAM layout (SMS_loadTiles at slot 4, first-half for sprites):
     Slot   4-  7 : BG tile 0          (tileNumber 1)
     Slot   8- 23 : Player sprite       (tileNumbers 2-5, reserved)
     Slot  24-151 : NPC sprite types 0-7 (16 sub-tiles each)
                                        (tileNumbers 6-37, reserved)
     Slot 152+    : BG tile 1,2,…       (tileNumber = bgIdx + 37)

   entities.dat (79 bytes per NPC):
     bytes 0-3:   room, x, y, sprite_type
     bytes 4-39:  dialog[36]     — default
     bytes 40-75: dialog2[36]    — conditional
     byte 76:     condition_var  (0..31 or 0xFF)
     byte 77:     reward_var
     byte 78:     cond_reward_var

   bgIdxToNum(i): i==0 → 1; i>=1 → i + 37
   ============================================================ */
(function() {
'use strict';

const BASE_ROM_B64 = "BASE_ROM_PLACEHOLDER";

const N_NPC_SPRITE_TYPES = 8; // must match MAX_NPC_SPRITE_TYPES in C
/* First tileNumber available for BG tiles, after the reserved sprite region.
   Layout: BG[0]=tile 1; player=tiles 2-5; NPC[0..N-1]=tiles 6..(6+4N-1).
   So the first BG tile (BG[1]) is at tile (6 + 4*N). */
const FIRST_BG_TILE = 6 + 4 * N_NPC_SPRITE_TYPES; // 38 for N=8

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
function bgIdxToNum(i) { return i === 0 ? 1 : i + (FIRST_BG_TILE - 1); }

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
const NPC_SPRITES = { default: [ [ null, null, null, 5, 5, 5, null, null ], [ null, null, 5, 5, 5, 5, 5, null ], [ null, null, 7, 1, 7, 1, 7, null ], [ 5, null, 7, 7, 7, 7, 7, null ], [ 5, null, 5, 5, 5, 5, 5, null ], [ 5, 7, 6, 5, 5, 5, 6, null ], [ 5, null, 6, 6, 5, 6, 6, null ], [ 5, null, 6, 6, 6, 6, 6, null ] ], 'default-elf': [ [ null, null, null, 11, 11, 11, null, null ], [ null, null, 11, 7, 11, 7, 11, null ], [ null, null, 10, 1, 10, 1, 10, null ], [ 11, null, 10, 11, 11, 10, 11, null ], [ 11, null, 10, 7, 7, 10, 10, null ], [ 11, 10, 11, 10, 10, 11, 10, null ], [ 11, null, 10, 10, 11, 10, 10, null ], [ 11, null, 10, 10, 10, 10, 10, null ] ], 'default-dwarf': [ [ null, null, null, 4, 4, 4, null, null ], [ null, null, 4, 4, 4, 4, 4, null ], [ null, null, 9, 9, 9, 9, 9, null ], [ 4, null, 9, 4, 4, 9, 4, null ], [ 4, null, 9, 4, 4, 9, 4, null ], [ 4, 9, 4, 9, 4, 9, 4, null ], [ 4, null, 9, 9, 4, 9, 9, null ], [ 4, null, 9, 9, 9, 9, 9, null ] ], 'old-mage': [ [ null, 1, 1, 1, 1, 1, null, null ], [ 1, 4, 6, 6, 6, 6, 1, null ], [ 1, 4, 15, 12, 15, 12, 1, null ], [ 1, 4, 15, 15, 15, 15, 5, 1 ], [ 1, 15, 5, 6, 6, 6, 15, 1 ], [ 1, 4, 5, 6, 6, 6, 1, null ], [ 1, 4, 5, 5, 6, 6, 1, null ], [ 1, 4, 5, 5, 5, 5, 1, null ] ], 'old-mage-elf': [ [ 1, 15, 10, 10, 10, 10, 15, 1 ], [ 1, 15, 15, 12, 15, 12, 15, 1 ], [ 1, 4, 15, 15, 15, 15, 1, null ], [ 1, 4, 10, 10, 10, 10, 5, 1 ], [ 1, 4, 5, 10, 10, 10, 5, 1 ], [ 1, 15, 5, 5, 10, 10, 15, null ], [ 1, 4, 5, 5, 5, 5, 1, null ], [ 1, 4, 5, 5, 5, 5, 1, null ] ], 'old-mage-dwarf': [ [ null, 1, null, null, null, null, null, null ], [ 1, 2, 1, 1, 1, 1, null, null ], [ 1, 4, 6, 6, 6, 6, 1, null ], [ 1, 4, 15, 9, 15, 9, 1, null ], [ 1, 4, 15, 15, 15, 15, 1, null ], [ 1, 4, 5, 6, 6, 6, 5, 1 ], [ 1, 15, 5, 5, 6, 6, 15, 1 ], [ 1, 4, 13, 1, 1, 13, 1, null ] ], 'villager-man': [ [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ null, 1, 15, 12, 15, 12, 1, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 4, 4, 4, 4, 4, 4, 1 ], [ 1, 15, 4, 4, 4, 4, 15, 1 ], [ null, 1, 9, 9, 9, 9, 1, null ], [ null, 1, 9, 1, 1, 9, 1, null ] ], 'villager-man-elf': [ [ 1, 15, 10, 10, 10, 10, 15, 1 ], [ 1, 10, 15, 12, 15, 12, 10, 1 ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 11, 11, 9, 9, 11, 11, 1 ], [ 1, 11, 11, 11, 9, 11, 11, 1 ], [ 1, 15, 11, 11, 9, 11, 15, 1 ], [ null, 1, 11, 11, 9, 11, 1, null ], [ null, 1, 11, 11, 9, 11, 1, null ] ], 'villager-man-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ null, 1, 15, 9, 15, 9, 1, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 4, 4, 5, 5, 5, 4, 1 ], [ 1, 15, 4, 4, 5, 5, 15, 1 ], [ null, 1, 9, 1, 1, 9, 1, null ] ], 'villager-woman': [ [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 4, 4, 4, 4, 1, null ], [ null, 1, 4, 12, 15, 12, 1, null ], [ null, 1, 4, 15, 15, 15, 1, null ], [ 1, 14, 4, 14, 14, 14, 14, 1 ], [ 1, 15, 4, 14, 14, 14, 15, 1 ], [ null, 1, 14, 14, 14, 14, 1, null ], [ null, 1, 14, 14, 14, 14, 1, null ] ], 'villager-woman-elf': [ [ 1, 15, 10, 10, 10, 10, 15, 1 ], [ 1, 10, 15, 12, 15, 12, 10, 1 ], [ 1, 10, 15, 15, 15, 15, 10, 1 ], [ 1, 10, 10, 9, 15, 10, 10, 1 ], [ 1, 11, 10, 11, 9, 10, 11, 1 ], [ 1, 15, 11, 11, 9, 11, 15, 1 ], [ null, 1, 11, 11, 9, 11, 1, null ], [ 1, 11, 11, 11, 9, 11, 11, 1 ] ], 'villager-woman-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ 1, 5, 15, 9, 15, 9, 1, null ], [ 1, 5, 15, 15, 15, 15, 1, null ], [ 1, 4, 5, 4, 4, 4, 4, 1 ], [ 1, 15, 5, 4, 4, 4, 15, 1 ], [ null, 1, 4, 4, 4, 4, 1, null ] ], 'child': [ [ null, null, null, null, null, null, null, null ], [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ null, 1, 15, 12, 15, 12, 1, null ], [ 1, 9, 9, 9, 9, 9, 9, 1 ], [ 1, 15, 9, 9, 9, 9, 15, 1 ], [ null, 1, 2, 1, 1, 2, 1, null ] ], 'child-elf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 10, 10, 10, 10, 1, null ], [ null, 1, 15, 12, 15, 12, 1, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 11, 11, 11, 11, 11, 11, 1 ], [ 1, 15, 11, 11, 11, 11, 15, 1 ], [ null, 1, 9, 1, 1, 9, 1, null ] ], 'child-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, null, null, null, null, null, null ], [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 15, 9, 15, 9, 1, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 15, 13, 13, 13, 13, 15, 1 ], [ null, 1, 2, 1, 1, 2, 1, null ] ], 'king': [ [ 1, 10, 1, 10, 1, 10, 1, 1 ], [ 1, 9, 9, 9, 9, 9, 1, 10 ], [ 1, 15, 15, 12, 15, 12, 1, 9 ], [ 1, 15, 15, 15, 15, 15, 1, 9 ], [ 1, 8, 7, 15, 15, 7, 1, 9 ], [ 1, 8, 8, 7, 8, 8, 8, 15 ], [ 1, 8, 8, 7, 8, 8, 1, 9 ], [ 1, 7, 7, 7, 7, 7, 1, 9 ] ], 'king-elf': [ [ 15, 10, 9, 10, 9, 10, 1, 10 ], [ 15, 10, 15, 12, 15, 12, 1, 9 ], [ 1, 10, 15, 15, 15, 15, 1, 9 ], [ 1, 11, 9, 15, 15, 9, 1, 9 ], [ 1, 11, 11, 15, 11, 11, 11, 15 ], [ 1, 11, 11, 10, 11, 11, 1, 9 ], [ 1, 11, 11, 10, 11, 11, 1, 9 ], [ 1, 10, 10, 10, 10, 10, 1, 9 ] ], 'king-dwarf': [ [ null, 1, 1, 1, 1, 1, null, null ], [ 1, 10, 9, 10, 9, 10, 1, 1 ], [ 1, 9, 9, 9, 9, 9, 1, 10 ], [ 1, 5, 15, 9, 15, 9, 1, 9 ], [ 1, 5, 15, 15, 15, 15, 1, 9 ], [ 1, 4, 4, 5, 5, 5, 4, 15 ], [ 1, 4, 4, 9, 4, 4, 1, 9 ], [ 1, 9, 9, 9, 9, 9, 1, 9 ] ], 'knight': [ [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 6, 6, 6, 6, 1, null ], [ null, 1, 6, 12, 15, 12, 1, null ], [ null, 1, 6, 6, 6, 6, 1, null ], [ 1, 5, 5, 6, 6, 5, 5, 1 ], [ 1, 6, 5, 5, 5, 5, 6, 1 ], [ null, 1, 6, 6, 6, 6, 1, null ], [ null, 1, 6, 1, 1, 6, 1, null ] ], 'knight-elf': [ [ 1, 15, 10, 10, 10, 10, 1, null ], [ 1, 15, 10, 12, 15, 12, 1, null ], [ 1, 4, 11, 15, 15, 15, 1, null ], [ 4, 11, 11, 15, 15, 11, 11, 1 ], [ 1, 11, 11, 11, 15, 11, 11, 1 ], [ 1, 15, 11, 11, 11, 11, 15, 1 ], [ null, 1, 11, 11, 11, 11, 4, null ], [ null, 1, 11, 1, 1, 11, 1, null ] ], 'knight-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 4, 4, 4, 4, 1, null ], [ null, 1, 4, 9, 15, 9, 1, null ], [ 1, 4, 4, 4, 4, 4, 4, 1 ], [ 1, 5, 4, 4, 4, 4, 5, 1 ], [ null, 1, 9, 9, 9, 9, 1, null ], [ null, 1, 9, 1, 1, 9, 1, null ] ], 'thief': [ [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ null, 1, 5, 12, 15, 12, 1, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ 1, 5, 5, 5, 5, 5, 5, 1 ], [ 1, 15, 5, 5, 5, 5, 15, 1 ], [ null, 1, 13, 13, 13, 13, 1, null ], [ null, 1, 13, 1, 1, 13, 1, null ] ], 'thief-elf': [ [ 1, 15, 10, 10, 10, 10, 15, 1 ], [ 1, 15, 10, 12, 15, 12, 15, 1 ], [ 1, 10, 15, 15, 15, 15, 10, 1 ], [ 1, 3, 5, 5, 5, 5, 3, 1 ], [ 1, 5, 5, 5, 5, 5, 5, 1 ], [ 1, 0, 5, 5, 5, 5, 0, 1 ], [ 1, 10, 5, 5, 5, 5, 10, 1 ], [ null, 1, 5, 1, 1, 5, 1, null ] ], 'thief-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ null, 1, 5, 9, 15, 9, 1, null ], [ 1, 5, 5, 5, 5, 5, 5, 1 ], [ 1, 15, 5, 5, 5, 5, 15, 1 ], [ null, 1, 4, 4, 4, 4, 1, null ], [ null, 1, 4, 1, 1, 4, 1, null ] ], 'blacksmith': [ [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ null, 1, 15, 12, 15, 12, 1, null ], [ null, 1, 15, 15, 15, 15, 1, null ], [ 1, 6, 4, 6, 6, 4, 6, 1 ], [ 1, 15, 4, 4, 4, 4, 15, 1 ], [ null, 1, 4, 4, 4, 4, 1, null ], [ null, 1, 5, 1, 1, 5, 1, null ] ], 'blacksmith-elf': [ [ 1, 15, 10, 10, 10, 10, 1, null ], [ 1, 15, 10, 12, 15, 12, 1, null ], [ 1, 10, 15, 15, 15, 15, 1, null ], [ 1, 6, 11, 6, 6, 11, 6, 1 ], [ 1, 6, 11, 11, 11, 11, 6, 1 ], [ 1, 15, 11, 11, 11, 11, 15, 1 ], [ null, 1, 11, 11, 11, 11, 1, null ], [ null, 1, 11, 1, 1, 11, 1, null ] ], 'blacksmith-dwarf': [ [ null, null, null, null, null, null, null, null ], [ null, null, 1, 1, 1, 1, null, null ], [ null, 1, 5, 5, 5, 5, 1, null ], [ null, 1, 15, 9, 15, 9, 1, null ], [ null, 1, 5, 15, 15, 15, 1, null ], [ 1, 6, 4, 5, 5, 5, 6, 1 ], [ 1, 15, 4, 4, 5, 5, 15, 1 ], [ null, 1, 4, 1, 1, 4, 1, null ] ], 'wooden-sign': [ [ null, 1, 1, 1, 1, 1, 1, null ], [ 1, 4, 4, 4, 4, 4, 4, 1 ], [ 1, 4, 5, 5, 5, 5, 4, 1 ], [ 1, 4, 4, 4, 4, 4, 4, 1 ], [ 1, 4, 5, 5, 5, 4, 4, 1 ], [ 1, 4, 4, 4, 4, 4, 4, 1 ], [ 1, 4, 1, 1, 1, 1, 4, 1 ], [ 1, 4, 1, null, null, 1, 4, 1 ] ], 'thought-bubble': [ [ null, 1, 1, 1, 1, 1, 1, null ], [ 1, 6, 6, 6, 6, 6, 6, 1 ], [ 1, 6, 1, 1, 1, 1, 6, 1 ], [ 1, 6, 6, 6, 6, 6, 6, 1 ], [ 1, 6, 1, 1, 1, 6, 6, 1 ], [ 1, 6, 6, 6, 6, 6, 6, 1 ], [ null, 1, 6, 6, 1, 1, 1, null ], [ null, 1, 6, 1, null, null, null, null ] ] };
// Elf and dwarf variants fall back to human equivalents
function getNpcSprite(type) {
    if (NPC_SPRITES[type]) return NPC_SPRITES[type];
    // strip -elf / -dwarf suffix and try base type
    const base = type.replace(/-(elf|dwarf)$/, '');
    return NPC_SPRITES[base] || NPC_SPRITES['default'];
}

// Object sprite matrices (8x8 palette indices), extracted from TRS ObjectSprites.ts
const OBJECT_SPRITES = {
    'player-start': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  1,  1,  1,  1,  1,  1, null ],
        [ null,  1,  3,  3,  3,  3,  1, null ],
        [ null,  1,  3,  3, 11,  3,  1, null ],
        [ null,  1,  3, 11,  3,  3,  1, null ],
        [ null,  1,  3,  3,  3,  3,  1, null ],
        [ null,  1,  1,  1,  1,  1,  1, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'player-end': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  1,  1,  1,  1,  1,  1, null ],
        [ null,  1,  2,  2,  2,  2,  1, null ],
        [ null,  1,  2,  2, 14,  2,  1, null ],
        [ null,  1,  2, 14,  2,  2,  1, null ],
        [ null,  1,  2,  2,  2,  2,  1, null ],
        [ null,  1,  1,  1,  1,  1,  1, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    switch: [
        [ null, null, null, null, null, null, null, null ],
        [  8, null, null, null, null, null, null, null ],
        [ null,  6, null, null, null, null, null, null ],
        [ null, null,  6, null, null, null, null, null ],
        [ null, null, null,  6, null, null, null, null ],
        [ null, null,  6,  1,  1,  6, null, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'switch--on': [
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, 12 ],
        [ null, null, null, null, null, null,  6, null ],
        [ null, null, null, null, null,  6, null, null ],
        [ null, null, null, null,  6, null, null, null ],
        [ null, null,  6,  1,  1,  6, null, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    key: [
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ],
        [ 10, 10,  7, null, null, null, null, null ],
        [ 10, null, 10, 10, 10, 10, 10, 10 ],
        [  9,  9,  9, null, null,  9, null,  9 ],
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    door: [
        [ null,  4,  4,  4,  4,  4,  4, null ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ],
        [  4,  9,  9,  9,  0,  0,  9,  4 ],
        [  4,  9,  9,  9,  0,  0,  9,  4 ],
        [  4,  9,  9,  9,  9,  0,  9,  4 ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ]
    ],
    'door-variable': [
        [ null,  7, null,  7, null,  7, null,  7 ],
        [ null,  6,  6,  6,  6,  6,  6,  6 ],
        [ null,  6, 13,  6, 13,  6, 13,  6 ],
        [ null,  6, null,  6, null,  6, null,  6 ],
        [ null,  6, null,  6, null,  6, null,  5 ],
        [ null,  6,  6,  6,  6,  6,  6,  6 ],
        [ null,  6, 13,  6, 13,  6, 13,  6 ],
        [ null,  6, null,  6, null,  6, null,  6 ]
    ],
    'life-potion': [
        [ null, null,  1,  1,  1,  1, null, null ],
        [ null,  1,  1,  1,  1,  1,  1, null ],
        [ null, null,  6, null, null,  6, null, null ],
        [ null, null,  6,  8,  8,  6, null, null ],
        [ null,  6,  8,  8,  8,  8,  6, null ],
        [  6,  8,  8,  8,  6,  8,  8,  6 ],
        [ null,  6,  8,  6,  8,  8,  6, null ],
        [ null, null,  6,  6,  6,  6, null, null ]
    ],
    'xp-scroll': [
        [ null, null, null, null, null, null, null, null ],
        [ null, null,  6,  6,  6,  6,  6,  6 ],
        [ null, null,  6,  1,  1,  1,  6,  0 ],
        [ null, null,  6,  6,  6,  6,  6, null ],
        [ null, null,  6,  1,  1,  1,  6, null ],
        [ null, null,  6,  6,  6,  6,  6, null ],
        [ null,  0,  6,  1,  1,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ]
    ],
    sword: [
        [ null, null, null, null, null, null, null, null ],
        [  6,  6, null, null, null, null, null, null ],
        [  6,  6,  6, null, null, null, null, null ],
        [ null,  6,  6,  6, null, null, null, null ],
        [ null, null,  6,  6,  6, null,  1, null ],
        [ null, null, null,  6,  8,  1,  1, null ],
        [ null, null, null, null,  1,  1, null, null ],
        [ null, null, null,  1,  1, null,  1, null ]
    ],
    'sword-bronze': [
        [ null, null, null, null, null, null, null, null ],
        [  9,  9, null, null, null, null, null, null ],
        [  9, 10,  9, null, null, null, null, null ],
        [ null,  9,  9, 10, null, null, null, null ],
        [ null, null,  9,  9, 10, null,  1, null ],
        [ null, null, null,  9,  9,  1,  1, null ],
        [ null, null, null, null,  1,  1, null, null ],
        [ null, null, null,  1,  1, null,  1, null ]
    ],
    'sword-wood': [
        [ null, null, null, null, null, null, null, null ],
        [  4,  4, null, null, null, null, null, null ],
        [  4,  5,  4, null, null, null, null, null ],
        [ null,  4,  4,  5, null, null, null, null ],
        [ null, null,  4,  4,  5, null,  1, null ],
        [ null, null, null,  4,  9,  1,  1, null ],
        [ null, null, null, null,  1,  1, null, null ],
        [ null, null, null,  1,  1, null,  1, null ]
    ],
    'logic-gate-not': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  6,  6, null, null, null, null, null ],
        [ null,  6,  6,  6,  6, null, null, null ],
        [ null,  6,  6,  6,  6,  6,  6,  7 ],
        [ null,  6,  6,  6,  6,  6,  6,  7 ],
        [ null,  6,  6,  6,  6, null, null, null ],
        [ null,  6,  6, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-gate-and': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  6,  6,  6,  6,  6, null, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-gate-or': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  6,  6,  6, null, null, null, null ],
        [ null, null,  6,  6,  6,  6, null, null ],
        [ null, null,  6,  6,  6,  6,  6, null ],
        [ null, null,  6,  6,  6,  6,  6, null ],
        [ null, null,  6,  6,  6,  6, null, null ],
        [ null,  6,  6,  6, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-gate-nand': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  6,  6,  6,  6,  6, null, null ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6,  6,  7 ],
        [ null,  6,  6,  6,  6,  6,  6,  7 ],
        [ null,  6,  6,  6,  6,  6,  6, null ],
        [ null,  6,  6,  6,  6,  6, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-gate-nor': [
        [ null, null, null, null, null, null, null, null ],
        [ null,  6,  6,  6, null, null, null, null ],
        [ null, null,  6,  6,  6,  6, null, null ],
        [ null, null,  6,  6,  6,  6,  6,  7 ],
        [ null, null,  6,  6,  6,  6,  6,  7 ],
        [ null, null,  6,  6,  6,  6, null, null ],
        [ null,  6,  6,  6, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-led': [
        [ null, null, null, null, null, null, null, null ],
        [ null, null,  5,  5,  5,  5, null, null ],
        [ null,  5,  5,  5,  5,  5,  5, null ],
        [ null,  5,  5,  5,  5,  5,  5, null ],
        [ null,  5,  5,  5,  5,  5,  5, null ],
        [ null,  5,  5,  5,  5,  5,  5, null ],
        [ null, null,  5,  5,  5,  5, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'logic-led--on': [
        [ null, null, null, null, null, null, null, null ],
        [ null, null,  7, 10, 10,  7, null, null ],
        [ null,  7, 10, 10, 10, 10,  7, null ],
        [ null,  7, 10, 10, 10, 10,  7, null ],
        [ null,  7, 10, 10, 10, 10,  7, null ],
        [ null,  7, 10, 10, 10, 10,  7, null ],
        [ null, null,  7, 10, 10,  7, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    armor: [
        [ null,  null,   1,   1,   1,   1,  null,  null ],
        [  1,   1,   1,   6,   6,   1,   1,   1 ],
        [  1,   6,   6,   6,   6,   6,   6,   1 ],
        [  1,   6,   6,   6,   6,   6,   6,   1 ],
        [  1,   1,   6,   6,   6,   6,   1,   1 ],
        [ null,   1,   7,   5,   5,   7,   1,  null ],
        [ null,   1,   6,   6,   6,   6,   1,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ]
    ],
    boots: [
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [  1,   1,   1,  null,   1,   1,   1,  null ],
        [  1,   4,   1,   1,   1,   4,   1,   1 ],
        [  1,   4,  15,   1,   1,   4,  15,   1 ],
        [  1,   4,   4,   1,   1,   4,   4,   1 ],
        [  1,   1,   1,   1,   1,   1,   1,   1 ]
    ],
    trap: [
        [ null, null, null, null, null, null, null, null ],
        [ null, null,  1, null, null, null,  1, null ],
        [ null,  1,  5,  1, null,  1,  5,  1 ],
        [ null,  5,  5,  5, null,  5,  5,  5 ],
        [ null, null,  1, null, null, null,  1, null ],
        [ null,  1,  5,  1, null,  1,  5,  1 ],
        [ null,  5,  5,  5, null,  5,  5,  5 ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'trap--on': [
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,   1,   1,   1,  null,   1,   1,   1 ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,   1,   1,   1,  null,   1,   1,   1 ],
        [ null,  null,  null,  null,  null,  null,  null,  null ]
    ],
    'push-box': [
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ],
        [ null,   1,   4,   4,   4,   4,   1,  null ],
        [ null,   1,   4,   4,   4,   4,   1,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ],
        [ null,   1,   4,   4,   4,   4,   1,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ]
    ],
    'pressure-plate': [
        [ null,  null,  null,  null,  null,  null,  null,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ],
        [ null,   1,   6,   6,   6,   6,   1,  null ],
        [ null,   1,   6,   7,   6,   6,   1,  null ],
        [ null,   1,   6,   6,   7,   6,   1,  null ],
        [ null,   1,   6,   6,   6,   6,   1,  null ],
        [ null,   1,   1,   1,   1,   1,   1,  null ],
        [ null,  null,  null,  null,  null,  null,  null,  null ]
    ],
    'pressure-plate--on': [
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ],
        [  1,  1,  1,  1,  1,  1,  1,  1 ],
        [  1, 12, 12, 12, 12, 12, 12,  1 ],
        [  1, 12, 12, 12, 12, 12, 12,  1 ],
        [  1,  1,  1,  1,  1,  1,  1,  1 ],
        [ null, null, null, null, null, null, null, null ],
        [ null, null, null, null, null, null, null, null ]
    ],
    chest: [
        [ null, null, null, null, null, null, null, null ],
        [  5,  5,  5,  5,  5,  5,  5,  5 ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ],
        [  4,  4,  4, 10, 10,  4,  4,  4 ],
        [  4,  4,  4,  4,  4,  4,  4,  4 ],
        [  4,  9,  9,  9,  9,  9,  9,  4 ],
        [  5,  5,  5,  5,  5,  5,  5,  5 ],
        [ null, null, null, null, null, null, null, null ]
    ],
    'chest--on': [
        [  5,   9,   9,  10,  10,   9,   9,   5 ],
        [  4,   1,   1,   1,   1,   1,   1,   4 ],
        [  4,   4,   1,   1,   1,   1,   4,   4 ],
        [  4,   4,   4,   1,   1,   4,   4,   4 ],
        [  4,   4,   4,   4,   4,   4,   4,   4 ],
        [  4,   9,   9,   9,   9,   9,   9,   4 ],
        [  5,   5,   5,   5,   5,   5,   5,   5 ],
        [ null, null, null, null, null, null, null, null ]
    ]
};
function getObjectSprite(name) {
    return OBJECT_SPRITES[name] || OBJECT_SPRITES['key'];
}


async function buildSMSRom() {
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
       Variants like 'knight-elf' / 'knight-dwarf' share the human slot
       since they fall back to the same pixels in NPC_SPRITES.
    */
    setStatus('Collecting NPC types…', '#8af');
    const allNpcs = Array.isArray(gameData.sprites) ? gameData.sprites : [];
    const placedNpcs = allNpcs.filter(n => n.placed !== false);

    // Build the canonical sprite key from TRS's (type, variant) pair.
    // TRS stores race in npc.variant ('human' | 'elf' | 'dwarf' | 'fixed').
    // The type already includes the suffix for elf/dwarf, but we double-check
    // so any TRS quirks still find the right pixels.
    const normalizeNpcType = (npc) => {
        const t = String((npc && npc.type) || 'default');
        const v = String((npc && npc.variant) || 'human');
        // 1. Exact match (e.g. 'knight-elf' from TRS) wins
        if (NPC_SPRITES[t]) return t;
        // 2. If the type has no suffix and variant is elf/dwarf, try type-variant
        if (v === 'elf' || v === 'dwarf') {
            const composed = t.replace(/-(elf|dwarf)$/, '') + '-' + v;
            if (NPC_SPRITES[composed]) return composed;
        }
        // 3. Strip suffix and try base type
        const base = t.replace(/-(elf|dwarf)$/, '');
        return NPC_SPRITES[base] ? base : 'default';
    };

    /* Per-room sprite-type assignment.
       Each room gets its own set of up to N_NPC_SPRITE_TYPES slots. When the
       player enters a room, the C code loads that room's sprite tiles into
       VRAM slots 24..(24+128). The NPC's sprite_type byte stored in
       entities.dat is the per-room slot index. */
    const ROOM_COUNT = 9;
    const roomTypeMaps = []; // [roomIdx] → Map(spriteName → slotIdx)
    for (let r = 0; r < ROOM_COUNT; r++) roomTypeMaps.push(new Map());

    let overflowCount = 0;
    for (const npc of placedNpcs) {
        const room = (npc.roomIndex|0);
        if (room < 0 || room >= ROOM_COUNT) continue;
        const sname = normalizeNpcType(npc);
        const m = roomTypeMaps[room];
        if (!m.has(sname)) {
            if (m.size < N_NPC_SPRITE_TYPES) {
                m.set(sname, m.size);
            } else {
                overflowCount++;
            }
        }
    }
    if (overflowCount > 0) {
        console.warn('[SMS] ' + overflowCount + ' NPC visual(s) exceeded ' +
            N_NPC_SPRITE_TYPES + ' types per room; extras fall back to slot 0.');
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
       Layout: BG[0] | player | NPC types 0..7 (always all 8 emitted) | BG[1..N]
       Emitting all N_NPC_SPRITE_TYPES NPC slots unconditionally keeps the C
       code's base_tile math correct. We fill them with the START ROOM's
       sprites so they look right at boot; the C will reload these slots on
       each room transition via load_room_sprites().
    */
    // Note: startRoom isn't known yet at this point — initialize with sane defaults,
    // then patch the start room slot fill after we resolve it below.
    const tileBuf = [];
    tileBuf.push(...encodeBGTile(getTilePx(liveTiles[0]), palette));  // BG[0], tileNum 1
    tileBuf.push(...buildSpriteFrames(PLAYER_SP));                     // player, tileNums 2-5
    // Sprite slots for room 0 will be patched in once startRoom is known.
    // For now, emit zero placeholders; they get overwritten below.
    const npcSlotOffset = tileBuf.length;
    const NPC_BLOCK_SIZE = 512; // 16 sub-tiles × 32 bytes
    for (let t = 0; t < N_NPC_SPRITE_TYPES; t++) {
        for (let b = 0; b < NPC_BLOCK_SIZE; b++) tileBuf.push(0);
    }
    for (let i = 1; i < liveTiles.length; i++)
        tileBuf.push(...encodeBGTile(getTilePx(liveTiles[i]), palette)); // BG[1..N]

    /* ── Tile attributes ──
       attrBuf[tileNumber-1] = 16-bit attribute word.
       Index 0: BG[0]; indices 1-4: player (reserved); indices 5..(FIRST_BG_TILE-2): NPC types (reserved);
       index (FIRST_BG_TILE-1)+i-1 (i>=1): BG[i].
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

    /* Patch the NPC sprite slots in main.til with the start room's sprites,
       so the boot screen renders correctly before the C code calls
       load_room_sprites for the first time. */
    {
        const startMap = roomTypeMaps[startRoom] || new Map();
        for (let s = 0; s < N_NPC_SPRITE_TYPES; s++) {
            let spriteName = 'default';
            for (const [k, v] of startMap) if (v === s) { spriteName = k; break; }
            const frames = buildSpriteFrames(getNpcSprite(spriteName));
            for (let b = 0; b < NPC_BLOCK_SIZE; b++) {
                tileBuf[npcSlotOffset + s * NPC_BLOCK_SIZE + b] = frames[b];
            }
        }
    }

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

    /* ── Object tiles ──
       BG tiles appended right after the start marker, one per object
       visual state. Most types contribute one tile; SWITCH contributes
       two (off/on) since toggling rewrites the cell to show its state.
       The C side learns each tile's number from the header bytes at
       the start of objects.dat — see objBuf below.
       
       Object sprites are 8x8 matrices of *palette indices* (or null for
       transparent), while encodeBGTile expects 8x8 of *hex color strings*.
       We composite the object on top of BG[0]'s pixels (the default floor
       tile) so null cells visually fall back to the floor — that way an
       object placed on grass appears as "object on grass" rather than
       "object on palette[0]". */
    // Order must match OBJ_TILE_* constants in the C source.
    const OBJECT_TILE_NAMES = [
        'key',             // OBJ_TILE_KEY
        'door',            // OBJ_TILE_DOOR
        'door-variable',   // OBJ_TILE_DOOR_VARIABLE
        'player-end',      // OBJ_TILE_PLAYER_END
        'switch',          // OBJ_TILE_SWITCH_OFF
        'switch--on',      // OBJ_TILE_SWITCH_ON
        'life-potion',     // OBJ_TILE_LIFE_POTION
        'xp-scroll',       // OBJ_TILE_XP_SCROLL
        'sword',           // OBJ_TILE_SWORD
        'sword-bronze',    // OBJ_TILE_SWORD_BRONZE
        'sword-wood',      // OBJ_TILE_SWORD_WOOD
    ];
    const objectTileFirst = startTileNum + 1;
    const floorPxHex = getTilePx(liveTiles[0]);
    for (let i = 0; i < OBJECT_TILE_NAMES.length; i++) {
        const matrix = getObjectSprite(OBJECT_TILE_NAMES[i]);
        const composed = matrix.map((row, r) => row.map((v, c) => {
            if (v != null) return palette[v] || palette[0];
            const fr = floorPxHex[r];
            return (fr && fr[c]) || palette[0];
        }));
        tileBuf.push(...encodeBGTile(composed, palette));
        const tn = objectTileFirst + i;
        // Extend attrBuf so far — all zero (no SOLID/PLAYER_END flags,
        // since interaction is intercepted in C before the SOLID check)
        while (attrBuf.length < tn * 2) attrBuf.push(0);
    }
    const objectTileLast = objectTileFirst + OBJECT_TILE_NAMES.length - 1;

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
       byte 0:        npc_count (max 16)
       per NPC (79 bytes):
         bytes 0..3:   room, x, y, sprite_type
         bytes 4..39:  dialog[36]            — default text (NUL-terminated)
         bytes 40..75: dialog2[36]           — conditional alternative text
         byte 76:      condition_var  (0..31 or 0xFF=none)
         byte 77:      reward_var     (set when default dialog closes)
         byte 78:      cond_reward_var (set when conditional dialog closes)

       Variable string IDs from TRS are mapped to a flat 0..31 index space.
       'skill:bard' and unknown IDs collapse to 0xFF (none).
    */
    setStatus('Building entity data…', '#8af');
    const NPC_DIALOG_LEN = 36;
    const MAX_VARS = 32;
    const VAR_NONE = 0xFF;
    const varToIdx = new Map();
    const getVarIdx = (varId) => {
        if (!varId) return VAR_NONE;
        const s = String(varId);
        if (s === 'skill:bard') return VAR_NONE; // no skill system on SMS port
        if (varToIdx.has(s)) return varToIdx.get(s);
        if (varToIdx.size >= MAX_VARS) {
            console.warn('[SMS] Variable budget (32) exhausted; ignoring', s);
            return VAR_NONE;
        }
        const idx = varToIdx.size;
        varToIdx.set(s, idx);
        return idx;
    };
    const encodeDialog = (raw) => {
        const text = (raw || '').slice(0, NPC_DIALOG_LEN - 1);
        const bytes = new Array(NPC_DIALOG_LEN).fill(0);
        for (let c = 0; c < text.length; c++) bytes[c] = text.charCodeAt(c) & 0xFF;
        return bytes;
    };
    const nNpcs = Math.min(placedNpcs.length, 32);
    const entBuf = [nNpcs];
    for (let i = 0; i < nNpcs; i++) {
        const npc  = placedNpcs[i];
        const room = (npc.roomIndex|0);
        const t    = normalizeNpcType(npc);
        const roomMap = roomTypeMaps[room] || new Map();
        const si   = roomMap.has(t) ? roomMap.get(t) : 0;
        const dialogBytes  = encodeDialog(npc.text);
        const dialog2Bytes = encodeDialog(npc.conditionText);
        const cv = getVarIdx(npc.conditionVariableId);
        const rv = getVarIdx(npc.rewardVariableId);
        const crv = getVarIdx(npc.conditionalRewardVariableId);
        entBuf.push(
            room & 0xFF,
            (npc.x || 0) & 0xFF,
            (npc.y || 0) & 0xFF,
            si & 0xFF,
            ...dialogBytes,
            ...dialog2Bytes,
            cv, rv, crv
        );
    }
    if (varToIdx.size > 0) {
        console.log('[SMS] Variable map (' + varToIdx.size + '/' + MAX_VARS + '):',
            Array.from(varToIdx.entries()));
    }

    /* ── objects.dat ──
       Header (N_OBJ_TILES = 11 bytes): BG tile number for each object tile slot,
                                       in OBJECT_TILE_NAMES order. Most types use
                                       one slot; SWITCH uses two (off/on).
       Byte 11:                      object_count (0..32)
       Bytes 12..:                   per object, 6 bytes:
                                         type      0..9 (KEY/DOOR/DOOR_VARIABLE/PLAYER_END/
                                                         SWITCH/LIFE_POTION/XP_SCROLL/
                                                         SWORD/SWORD_BRONZE/SWORD_WOOD)
                                         room      0..8
                                         x, y      0..7
                                         var_idx   0..31 or 0xFF
                                         flags     reserved, written as 0   */
    const OBJ_TYPE_MAP = {
        'key':            0,
        'door':           1,
        'door-variable':  2,
        'player-end':     3,
        'switch':         4,
        'life-potion':    5,
        'xp-scroll':      6,
        'sword':          7,
        'sword-bronze':   8,
        'sword-wood':     9,
    };
    const MAX_OBJECTS = 32;
    const rawObjects = Array.isArray(gameData.objects) ? gameData.objects : [];
    const placedObjects = rawObjects.filter(o =>
        o && o.type && OBJ_TYPE_MAP[o.type] !== undefined &&
        Number.isFinite(o.roomIndex) && o.roomIndex >= 0 && o.roomIndex < ROOM_COUNT &&
        Number.isFinite(o.x) && o.x >= 0 && o.x < 8 &&
        Number.isFinite(o.y) && o.y >= 0 && o.y < 8
    ).slice(0, MAX_OBJECTS);
    const objBuf = [];
    // Header: tile numbers, one per OBJECT_TILE_NAMES entry
    for (let i = 0; i < OBJECT_TILE_NAMES.length; i++) {
        objBuf.push((objectTileFirst + i) & 0xFF);
    }
    // Count and instances
    objBuf.push(placedObjects.length & 0xFF);
    for (const o of placedObjects) {
        const typeCode = OBJ_TYPE_MAP[o.type];
        const varIdx = getVarIdx(o.variableId);
        objBuf.push(
            typeCode & 0xFF,
            o.roomIndex & 0xFF,
            (o.x|0) & 0xFF,
            (o.y|0) & 0xFF,
            varIdx & 0xFF,
            0
        );
    }
    if (placedObjects.length > 0) {
        console.log('[SMS] Objects (' + placedObjects.length + '/' + MAX_OBJECTS + '):',
            placedObjects.map(o => `${o.type}@r${o.roomIndex}(${o.x},${o.y})${o.variableId ? '/' + o.variableId : ''}`));
    }

    /* ── endings.dat ──
       9 fixed-length slots (one per room), 36 bytes each, total 324 bytes.
       Each slot is the endingText from that room's player-end object (if any),
       null-padded. The C side reads this in load_endings(); handle_object_at
       shows the matching text in the dialog row when PLAYER_END fires. */
    const ENDING_TEXT_LEN = 36;
    const endingsBuf = [];
    for (let r = 0; r < ROOM_COUNT; r++) {
        const pe = rawObjects.find(o => o && o.type === 'player-end' &&
                                          o.roomIndex === r &&
                                          typeof o.endingText === 'string' &&
                                          o.endingText.length > 0);
        const txt = pe ? String(pe.endingText).slice(0, ENDING_TEXT_LEN - 1) : '';
        for (let i = 0; i < ENDING_TEXT_LEN; i++) {
            endingsBuf.push(i < txt.length ? (txt.charCodeAt(i) & 0xFF) : 0);
        }
    }

    /* ── project.inf / merging.dat ── */
    const worldCols = (gameData.world && gameData.world.cols) ? Math.max(1, gameData.world.cols) : 3;
    const worldRows = (gameData.world && gameData.world.rows) ? Math.max(1, gameData.world.rows) : 3;
    const projInfo = [...strBytes('SMS-RPG-Studio'),...strBytes('1.0'),...strBytes(title),
        worldCols & 0xFF, worldRows & 0xFF];
    const totalTN = objectTileLast;
    const combos = [...u16(totalTN), ...new Array(totalTN * totalTN).fill(0)];

    /* ── Per-room sprite files ──
       For each room, emit a 4 KB file (8 sprite types × 16 sub-tiles × 32 bytes)
       containing the sprite tile data for that room. The C code's
       load_room_sprites() loads this into VRAM slots 24..151 on entry. */
    const spriteFiles = [];
    for (let r = 0; r < ROOM_COUNT; r++) {
        const sprBuf = [];
        const m = roomTypeMaps[r];
        for (let s = 0; s < N_NPC_SPRITE_TYPES; s++) {
            let spriteName = 'default';
            for (const [k, v] of m) { if (v === s) { spriteName = k; break; } }
            sprBuf.push(...buildSpriteFrames(getNpcSprite(spriteName)));
        }
        spriteFiles.push({
            name: `room${String(r+1).padStart(2,'0')}.spr`,
            content: sprBuf
        });
    }

    /* ── Assemble resource filesystem ── */
    setStatus('Building resource filesystem…', '#8af');
    const files = [
        { name:'main.pal',    content:Array.from(palBytes) },
        { name:'main.til',    content:tileBuf },
        { name:'main.atr',    content:attrBuf },
        { name:'entities.dat',content:entBuf },
        { name:'objects.dat', content:objBuf },
        { name:'endings.dat', content:endingsBuf },
        { name:'project.inf', content:projInfo },
        { name:'merging.dat', content:combos },
        ...mapFiles,
        ...spriteFiles
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

    // Count total unique sprite types across all rooms (for reporting only)
    const allSprites = new Set();
    for (const m of roomTypeMaps) for (const k of m.keys()) allSprites.add(k);
    const nTypes = allSprites.size;
    const summary = `${kb} KB · ${liveTiles.length} tiles · ${nNpcs} NPCs` +
        ` (${nTypes} sprite${nTypes!==1?'s':''}) · ${placedObjects.length} obj · start: room ${startRoom+1} (${startX},${startY})`;

    return { rom, filename, title, summary };
}

function downloadRomBytes(rom, filename) {
    let bin = '';
    for (let i = 0; i < rom.length; i++) bin += String.fromCharCode(rom[i]);
    const dataUrl = 'data:application/octet-stream;base64,' + btoa(bin);
    const a = document.createElement('a');
    a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
}

async function handleExportClick() {
    const btn = document.getElementById('btn-generate-sms-rom');
    if (!btn) return;
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');
    try {
        const { rom, filename, summary } = await buildSMSRom();
        downloadRomBytes(rom, filename);
        setStatus('✓ ' + summary, '#4f8');
    } catch(err) {
        console.error('[SMS ROM Export]', err);
        setStatus('Error: ' + err.message, '#f88');
    } finally {
        btn.disabled = false;
    }
}

/* ============================================================
   EmulatorJS integration
   Loads https://cdn.emulatorjs.org/stable/data/loader.js with
   EJS_core = "segaMS" and the freshly-built ROM as a Blob URL.
   ============================================================ */

let _emuLoaderInjected = false;
let _emuCurrentBlobUrl = null;

function teardownEmulator() {
    try {
        if (window.EJS_emulator && typeof window.EJS_emulator.callEvent === 'function') {
            window.EJS_emulator.callEvent('exit');
        }
    } catch (e) { /* ignore */ }
    const target = document.getElementById('sms-emulator-target');
    if (target) target.innerHTML = '';
    if (_emuCurrentBlobUrl) {
        try { URL.revokeObjectURL(_emuCurrentBlobUrl); } catch (e) {}
        _emuCurrentBlobUrl = null;
    }
    // Clear global EJS state so next launch starts fresh
    delete window.EJS_emulator;
    delete window.EJS_player;
    delete window.EJS_core;
    delete window.EJS_gameUrl;
    delete window.EJS_pathtodata;
    delete window.EJS_startOnLoaded;
    delete window.EJS_gameName;
    _emuLoaderInjected = false;
}

function openEmulatorModal() {
    const modal = document.getElementById('sms-emulator-modal');
    if (modal) modal.style.display = 'flex';
}

function closeEmulatorModal() {
    const modal = document.getElementById('sms-emulator-modal');
    if (modal) modal.style.display = 'none';
    teardownEmulator();
}

function launchEmulatorWithRom(rom, gameName) {
    // Always tear down any existing emulator first (so Reload works)
    teardownEmulator();

    const blob = new Blob([rom], { type: 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    _emuCurrentBlobUrl = blobUrl;

    window.EJS_player       = '#sms-emulator-target';
    window.EJS_core         = 'segaMS';
    window.EJS_gameUrl      = blobUrl;
    window.EJS_pathtodata   = 'https://cdn.emulatorjs.org/stable/data/';
    window.EJS_startOnLoaded= true;
    window.EJS_gameName     = gameName || 'SMS RPG Game';

    openEmulatorModal();

    const loaderScript = document.createElement('script');
    loaderScript.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    loaderScript.async = true;
    loaderScript.onerror = () => {
        setStatus('Failed to load EmulatorJS — check your connection.', '#f88');
        closeEmulatorModal();
    };
    document.body.appendChild(loaderScript);
    _emuLoaderInjected = true;
}

async function handlePlayClick() {
    const btn = document.getElementById('btn-play-sms-rom');
    if (!btn) return;
    btn.disabled = true;
    setStatus('Building ROM…', '#8af');
    try {
        const { rom, title, summary } = await buildSMSRom();
        setStatus('▶ Launching emulator… ' + summary, '#4ac04a');
        launchEmulatorWithRom(rom, title);
    } catch(err) {
        console.error('[SMS Play]', err);
        setStatus('Error: ' + err.message, '#f88');
    } finally {
        btn.disabled = false;
    }
}

function wireSmsButton() {
    const exportBtn = document.getElementById('btn-generate-sms-rom');
    const playBtn   = document.getElementById('btn-play-sms-rom');
    const closeBtn  = document.getElementById('sms-emulator-close');
    const reloadBtn = document.getElementById('sms-emulator-reload');
    const modal     = document.getElementById('sms-emulator-modal');

    if (!exportBtn || !playBtn || !closeBtn || !reloadBtn || !modal) {
        setTimeout(wireSmsButton, 500);
        return;
    }

    exportBtn.addEventListener('click', handleExportClick);
    playBtn.addEventListener('click',   handlePlayClick);
    closeBtn.addEventListener('click',  closeEmulatorModal);
    reloadBtn.addEventListener('click', handlePlayClick);

    // Close on Escape or backdrop click
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') closeEmulatorModal();
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeEmulatorModal();
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSmsButton);
else wireSmsButton();

})();
</script>
