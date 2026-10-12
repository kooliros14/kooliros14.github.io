// DroidBox disk service worker: serves the virtual disk file
// "droidbox-ics.img" by stitching together 8 MiB block files stored
// under disk/ (all-zero blocks are synthesized). This lets a static
// host serve a 551 MiB disk image as many small files, with the
// range requests v86's async disk loader makes.
const CACHE = "droidbox-disk-v1";
let manifestPromise = null;

function loadManifest() {
    if (!manifestPromise) {
        manifestPromise = fetch("disk/manifest.json").then((r) => r.json());
    }
    return manifestPromise;
}

async function getBlock(i) {
    const url = new URL("disk/b" + String(i).padStart(3, "0") + ".bin",
                        self.location.href).href;
    const cache = await caches.open(CACHE);
    let resp = await cache.match(url);
    if (!resp) {
        resp = await fetch(url);
        if (resp && resp.ok) cache.put(url, resp.clone());
    }
    return new Uint8Array(await resp.arrayBuffer());
}

async function serveDisk(request) {
    const m = await loadManifest();
    const BS = m.block_size;
    const total = m.size;
    const present = new Set(m.blocks);
    let start = 0;
    let end = total - 1;
    let ranged = false;
    const range = request.headers.get("range");
    if (range) {
        const mm = /bytes=(\d+)-(\d*)/.exec(range);
        if (mm) {
            ranged = true;
            start = parseInt(mm[1], 10);
            if (mm[2]) end = Math.min(parseInt(mm[2], 10), total - 1);
        }
    }
    const len = end - start + 1;
    const out = new Uint8Array(len);
    const first = Math.floor(start / BS);
    const last = Math.floor(end / BS);
    for (let i = first; i <= last; i++) {
        if (!present.has(i)) continue; // zeros
        const blk = await getBlock(i);
        const bStart = i * BS;
        const s = Math.max(start, bStart);
        const e = Math.min(end, bStart + BS - 1);
        out.set(blk.subarray(s - bStart, e - bStart + 1), s - start);
    }
    const headers = {
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": String(len),
    };
    if (ranged) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + total;
    return new Response(out, { status: ranged ? 206 : 200, headers });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
    const u = new URL(e.request.url);
    if (u.pathname.endsWith("/droidbox-ics.img")) {
        e.respondWith(serveDisk(e.request));
    }
});
