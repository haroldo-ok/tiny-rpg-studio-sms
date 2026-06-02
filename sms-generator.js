
<script>
/* ============================================================
   SMS ROM GENERATOR for Tiny RPG Studio
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

function encodeSMSTile(pixels, palette) {
    const bytes = [];
    for (let row = 0; row < 8; row++) {
        const planes = [0, 0, 0, 0];
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

function buildResourceFS(files) {
    const PAGE = 16384;
    const ENTRY = 20;
    files = files.slice().sort((a, b) => a.name < b.name ? -1 : 1);
    const hdr = [...strBytes('rsc', 4), ...u16(files.length)];
    const initOff = hdr.length + files.length * ENTRY;
    let page = 2, off = initOff;
    const alloc = files.map(f => {
        if (off + f.content.length > PAGE) { page++; off = 0; }
        const e = { name: f.name, page, off, content: f.content };
        off += f.content.length;
        return e;
    });
    const tbl = alloc.flatMap(a => [...strBytes(a.name, 14), ...u16(a.page), ...u16(a.content.length), ...u16(a.off)]);
    const pages = [new Array(PAGE).fill(0)];
    [...hdr, ...tbl].forEach((b, i) => { pages[0][i] = b; });
    alloc.forEach(a => {
        const pi = a.page - 2;
        while (pages.length <= pi) pages.push(new Array(PAGE).fill(0));
        a.content.forEach((b, i) => { pages[pi][a.off + i] = b; });
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

        const DEFAULT_PAL = [
            '#000000','#1D2B53','#7E2553','#008751',
            '#AB5236','#5F574F','#C2C3C7','#FFF1E8',
            '#FF004D','#FFA300','#FFFF27','#00E756',
            '#29ADFF','#83769C','#FF77A8','#FFCCAA'
        ];
        const palette = (Array.isArray(gameData && gameData.customPalette) && gameData.customPalette.length === 16)
            ? gameData.customPalette : DEFAULT_PAL;

        const palBytes = palette.map(hexToSmsByte);

        const liveTiles = api.getTiles();
        if (!Array.isArray(liveTiles) || !liveTiles.length) throw new Error('No tiles found.');

        const idToIdx = new Map();
        liveTiles.forEach((t, i) => idToIdx.set(String(t.id), i));

        const tileBuf = [];
        for (const t of liveTiles) {
            const px = (t.pixels && t.pixels.length) ? t.pixels : Array.from({length:8}, ()=>Array(8).fill('transparent'));
            tileBuf.push(...encodeSMSTile(px, palette));
        }

        const attrBuf = liveTiles.flatMap(t => u16(t.collision ? 1 : 0));

        const mapFiles = [];
        for (let r = 0; r < 9; r++) {
            const tm = api.getTileMap(r);
            const ground = (tm && tm.ground) || [];
            const overlay = (tm && tm.overlay) || [];
            const bytes = [];
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    const ov = overlay[row] && overlay[row][col];
                    const gr = ground[row] && ground[row][col];
                    const tid = (ov != null) ? ov : (gr != null) ? gr : null;
                    const idx = (tid != null && idToIdx.has(String(tid))) ? idToIdx.get(String(tid)) : 0;
                    bytes.push(idx + 1);
                }
            }
            const content = [...u16(r+1), ...u16(8), ...u16(8), ...strBytes(`Room ${r+1}`, 32), ...bytes];
            mapFiles.push({ name: `level${String(r+1).padStart(3,'0')}.map`, content });
        }

        const projInfo = [...strBytes('SMS-RPG-Studio'), ...strBytes('1.0'), ...strBytes(title)];
        const n = liveTiles.length;
        const combos = [...u16(n), ...new Array(n * n).fill(0)];

        const resourceData = buildResourceFS([
            { name: 'main.pal',    content: Array.from(palBytes) },
            { name: 'main.til',    content: tileBuf },
            { name: 'main.atr',    content: attrBuf },
            { name: 'project.inf', content: projInfo },
            { name: 'merging.dat', content: combos },
            ...mapFiles
        ]);

        const baseRom = b64ToBytes(BASE_ROM_B64);
        const rom = new Uint8Array(baseRom.length + resourceData.length);
        rom.set(baseRom);
        resourceData.forEach((b, i) => { rom[baseRom.length + i] = b; });

        const kb = Math.ceil(rom.length / 1024);
        const safeTitle = title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'my-tiny-rpg';
        const filename = `${safeTitle}.sms`;

        // Build base64 data URL
        let bin = '';
        for (let i = 0; i < rom.length; i++) bin += String.fromCharCode(rom[i]);
        const dataUrl = 'data:application/octet-stream;base64,' + btoa(bin);

        // Trigger download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();

        setStatus(`✓ ROM exported! ${kb} KB · ${n} tiles · 9 rooms — open in Emulicious, Meka, or RetroArch.`, '#4f8');

    } catch (err) {
        console.error('[SMS ROM Export]', err);
        setStatus('Error: ' + err.message, '#f88');
    } finally {
        btn.disabled = false;
    }
}

function wireSmsButton() {
    const btn = document.getElementById('btn-generate-sms-rom');
    if (btn) {
        btn.addEventListener('click', generateSMSRom);
    } else {
        setTimeout(wireSmsButton, 500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSmsButton);
} else {
    wireSmsButton();
}

})();
</script>
