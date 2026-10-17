// The dithered sea at the bottom of the home page: a small rendered seascape off the Wicklow coast.
// Runs in a worker on an OffscreenCanvas so it never blocks the page; falls back to the main thread.
function createSea(cv, still, onDrawn) {
  const ctx = cv.getContext('2d');
  const mask = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // Ocean: long swells under shorter wind waves (deep-water dispersion), seen from a camera 3 m above the water
  const G = 9.81, CAM = 3;
  const WAVES = [[46, -.12], [29, .22], [11, -.3], [7.3, .35], [5.1, -.75], [3.6, .6], [2.5, -.1], [1.7, .95], [1.2, -.5], [.8, .25], [.55, -.95]]
    .map(([len, ang], i) => {
      const k = 2 * Math.PI / len;
      return { k, dx: Math.sin(ang), dz: -Math.cos(ang), a: len * .015, w: Math.sqrt(G * k), p: i * 2.1 };
    });
  const NW = WAVES.length, FOAM_A = 6, FOAM_B = 7; // two mid waves whose crossing breaks up the whitecaps

  // a low sun, a little left of centre, setting over the hills
  const SUN = (() => { const v = [-.2, .03, 1], l = Math.hypot(...v); return v.map(c => c / l); })();
  const SUN_COS = Math.cos(.024);

  // The Wicklow coast seen from the sea, as elevation angles against bearing:
  // the long range behind, the Great and Little Sugar Loaf, and Bray Head close by on the right.
  const bump = (x, c, a, w) => a * Math.exp(-(((x - c) / w) ** 2));
  const peak = (x, c, a, w) => { const d = Math.sqrt(((x - c) / w) ** 2 + .01) - .1; return d >= 1 ? 0 : a * Math.max(0, 1 - d) ** 1.3; };
  const farRidge = az => .006 + .012 * smooth(-.6, -.2, az) + bump(az, -.05, .012, .12) + peak(az, .12, .046, .075)
    + peak(az, .245, .024, .035) + bump(az, .27, .01, .05) + .003 * Math.sin(az * 37) + .002 * Math.sin(az * 83 + 1);
  const nearRidge = az => smooth(.28, .38, az) * (.028 + .004 * Math.sin(az * 40));

  // light arriving from direction (x, y, z); far/near are the ridge heights on this bearing
  function sky(x, y, z, far, near) {
    const e = y / Math.hypot(x, z);
    if (e < near) return .2 + .08 * Math.exp(-e / .004);
    if (e < far) return .38 + .16 * Math.exp(-e / .005);
    const c = x * SUN[0] + y * SUN[1] + z * SUN[2];
    let L = .3 + .32 * Math.exp(-Math.max(0, y) * 9) + .9 * Math.exp((c - 1) * 700) + .35 * Math.exp((c - 1) * 50);
    if (c > SUN_COS) L += 8;
    return L;
  }

  // boat: 100 units tall, waterline at 0, bow to the right
  const HULL = new Path2D('M-34,-4L36,-7Q31,3 19,5L-21,5Q-29,2 -34,-4Z');
  const MAIN = new Path2D('M-3,-96Q-13,-55 -30,-11L-3,-11Z');
  const JIB = new Path2D('M2,-90Q12,-52 28,-12L2,-12Z');

  let size = { w: 0, h: 0 }, theme = null;
  let W, H, F, HZ, cx, cov, out, img, sunPx, skyCov, skySun, vigX, vigY, FAR, NEAR, rows, dark, expo, INK, ACC;
  const ws = new Float64Array(NW), wc = new Float64Array(NW);

  // the cursor brings a gust: the sea heaves and breaks into whitecaps around it
  const gust = { X: 0, Z: 0, tx: 0, tz: 0, k: 0, tk: 0 };
  const gustAt = (X, Z) => {
    const R = 8 + .3 * gust.Z, dX = X - gust.X, dZ = (Z - gust.Z) * .6;
    return gust.k * Math.exp(-(dX * dX + dZ * dZ) / (R * R));
  };

  const pack = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const hex = h => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const RED = pack(255, 72, 72, 255), RED_HALO = pack(255, 72, 72, 110);
  const GREEN = pack(64, 224, 128, 255), GREEN_HALO = pack(64, 224, 128, 110);
  let INK_HALO;
  const toCov = L => { const tone = 1 - Math.exp(-L * expo); return dark ? Math.pow(tone, 1.6) : Math.pow(1 - tone, 1.1); };

  function setup() {
    if (!size.w || !size.h || !theme) return;
    W = size.w; H = size.h;
    cv.width = mask.width = W; cv.height = mask.height = H;
    F = W * .95; HZ = Math.round(H * .4); cx = W / 2;
    cov = new Float32Array(W * H); sunPx = new Uint8Array(W * H);
    img = ctx.createImageData(W, H); out = new Uint32Array(img.data.buffer);
    const bg = hex(theme.bg);
    dark = (bg[0] + bg[1] + bg[2]) / 3 < 128;
    expo = dark ? 1.1 : 2.4;
    const art = theme.art.split(',').map(Number);
    INK = pack(...art, 255); INK_HALO = pack(...art, 110);
    ACC = pack(...hex(theme.sun), 255);

    vigX = new Float32Array(W); FAR = new Float32Array(W); NEAR = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const u = (x + .5) / W, az = (x + .5 - cx) / F;
      vigX[x] = smooth(0, .22, u) * smooth(1, .78, u);
      FAR[x] = farRidge(az); NEAR[x] = nearRidge(az);
    }
    vigY = new Float32Array(H);
    for (let y = 0; y < H; y++) { const v = (y + .5) / H; vigY[y] = smooth(0, .42, v) * smooth(1, .66, v); }

    // the sky and hills never move: work them out once
    skyCov = new Float32Array(W * HZ); skySun = new Uint8Array(W * HZ);
    for (let y = 0; y < HZ; y++) {
      const a = (y + .5 - HZ) / F;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, px = (x + .5 - cx) / F;
        const l = Math.hypot(px, -a, 1), dx = px / l, dy = -a / l, dz = 1 / l;
        const e = dy / Math.hypot(dx, dz), onLand = e < FAR[x] || e < NEAR[x];
        let c = toCov(sky(dx, dy, dz, FAR[x], NEAR[x]));
        // on paper the sky stays clean, with a thin haze along the horizon
        if (!dark && !onLand) c = .34 * Math.exp(-(HZ - y) / 5);
        skyCov[i] = c * vigX[x] * vigY[y];
        skySun[i] = !onLand && dx * SUN[0] + dy * SUN[1] + dz * SUN[2] > SUN_COS ? 1 : 0;
      }
    }

    // per water row: distance, and which waves are still visible at that distance (the rest would only alias)
    rows = [];
    for (let y = HZ; y < H; y++) {
      const a = (y + .5 - HZ) / F, Z = CAM / a;
      const foot = Z / F + Z * Z / (CAM * F) * .7;
      const act = [];
      WAVES.forEach((w, i) => {
        const att = Math.exp(-((w.k * foot) ** 2) * .6);
        if (att > .03 || (Z < 70 && (i === FOAM_A || i === FOAM_B))) act.push({ i, w, A: w.a * att });
      });
      rows.push({ a, Z, act, amp: act.reduce((s, q) => s + q.A, 0) });
    }
  }

  function frame(ms) {
    const t = still ? 40 : ms / 1000 + 40;
    gust.k += (gust.tk - gust.k) * .05;
    gust.X += (gust.tx - gust.X) * .12; gust.Z += (gust.tz - gust.Z) * .12;
    const gusting = gust.k > .01;

    // the boat, far out near the sun's path, drifting slowly to the right
    const BZ = 140, span = 170;
    const BX = SUN[0] / SUN[2] * BZ + 14 + (still ? 0 : t * .45);
    const bxw = ((BX + span / 2) % span + span) % span - span / 2;
    let bh = 0, bhx = 0;
    for (const w of WAVES) {
      const ph = w.k * (w.dx * bxw + w.dz * BZ) - w.w * t + w.p;
      bh += Math.sin(ph) * w.a; bhx += Math.cos(ph) * w.a * w.k * w.dx;
    }
    const bg = 1 + 1.8 * (gusting ? gustAt(bxw, BZ) : 0);
    bh *= bg; bhx *= bg;
    const ppm = F / BZ;
    const bsx = cx + bxw * ppm, bsy = HZ + CAM / BZ * F - bh * ppm;
    mctx.clearRect(0, 0, W, H);
    mctx.save(); mctx.translate(bsx, bsy); mctx.rotate(Math.atan(bhx) * .7);
    mctx.scale(.075 * ppm, .075 * ppm);
    mctx.fillStyle = '#000';
    mctx.fill(HULL); mctx.fill(MAIN); mctx.fill(JIB); mctx.fillRect(-1.2, -100, 2.4, 96);
    mctx.restore();
    const bx0 = Math.max(0, Math.floor(bsx - 12 * ppm * .075 * 6)), bw = Math.min(W - bx0, Math.ceil(ppm * .075 * 150));
    const by0 = Math.max(0, Math.floor(bsy - ppm * .075 * 110)), bhgt = Math.min(H - by0, Math.ceil(ppm * .075 * 125));
    const boat = bw > 0 && bhgt > 0 ? mctx.getImageData(bx0, by0, bw, bhgt).data : null;
    const boatA = (x, y) => {
      if (!boat) return 0;
      const lx = x - bx0, ly = y - by0;
      return lx < 0 || ly < 0 || lx >= bw || ly >= bhgt ? 0 : boat[(ly * bw + lx) * 4 + 3] / 255;
    };
    const wl = Math.round(bsy);

    cov.set(skyCov); sunPx.fill(0); sunPx.set(skySun);

    for (let y = HZ; y < H; y++) {
      const R = rows[y - HZ], a = R.a, Z = R.Z, act = R.act, vy0 = vigY[y];
      const foamy = Z < 70, foamFade = 1 - smooth(25, 70, Z);
      // only the far water mirrors the hills
      const landK = smooth(30, 110, Z);
      // each wave's phase is linear along the row: step sin/cos by rotation instead of calling trig per pixel
      const steps = act.map(q => {
        const w = q.w, B = w.k * w.dx * Z / F;
        const ph0 = w.k * (w.dx * ((.5 - cx) / F) * Z + w.dz * Z) - w.w * t + w.p;
        ws[q.i] = Math.sin(ph0); wc[q.i] = Math.cos(ph0);
        return [q.i, Math.cos(B), Math.sin(B), q.A, q.A * w.k * w.dx, q.A * w.k * w.dz];
      });
      for (let x = 0; x < W; x++) {
        const i = y * W + x, px = (x + .5 - cx) / F;
        let hx = 0, hz = 0, h = 0;
        for (let j = 0; j < steps.length; j++) {
          const st = steps[j], n = st[0], s = ws[n], c = wc[n];
          h += s * st[3]; hx += c * st[4]; hz += c * st[5];
          ws[n] = s * st[1] + c * st[2]; wc[n] = c * st[1] - s * st[2];
        }
        let g = 0;
        if (gusting) { g = gustAt(px * Z, Z); const m = 1 + 1.8 * g; hx *= m; hz *= m; h *= m; }
        const nl = Math.hypot(hx, 1, hz), nx = -hx / nl, ny = 1 / nl, nz = -hz / nl;
        const vl = Math.hypot(px, a, 1), vx = px / vl, vy = -a / vl, vz = 1 / vl;
        const d = vx * nx + vy * ny + vz * nz;
        const rx = vx - 2 * d * nx, ry = Math.max(.002, vy - 2 * d * ny), rz = vz - 2 * d * nz;
        const q = 1 + Math.min(0, d), q2 = q * q, fres = .02 + .8 * q2 * q2 * q;
        let L = fres * Math.min(1.6, sky(rx, ry, rz, FAR[x] * landK, NEAR[x] * landK)) + (1 - fres) * .03;
        // whitecaps on the nearer crests, more of them in a gust
        if (foamy) {
          const brk = ws[FOAM_A] * wc[FOAM_B];
          L += 1.4 * foamFade * smooth(.66, .92, h / (R.amp + 1e-3) + .2 * brk + .35 * g);
        }
        // reflection of the boat, broken up by the swell
        if (y > wl && y < wl + 30) {
          const ma = boatA(x + Math.round(Math.sin(y * 1.3 + t * 2.5) * 1.5), 2 * wl - y);
          if (ma) L *= 1 - .75 * ma * (1 - (y - wl) / 30);
        }
        cov[i] = toCov(L) * vigX[x] * vy0;
      }
    }

    // the boat is a backlit silhouette: solid ink on paper, a dark cut-out at night
    if (boat) {
      for (let y = by0; y < by0 + bhgt; y++) for (let x = bx0; x < bx0 + bw; x++) {
        const b = boatA(x, y);
        if (!b) continue;
        const i = y * W + x, v = vigX[x] * vigY[y];
        cov[i] = dark ? cov[i] * (1 - b) : cov[i] + (v - cov[i]) * b;
        if (b > .3) sunPx[i] = 0;
      }
    }

    // Atkinson dithering
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, old = cov[i], on = old > .5 ? 1 : 0, e = (old - on) / 8;
        if (x + 1 < W) cov[i + 1] += e;
        if (x + 2 < W) cov[i + 2] += e;
        if (y + 1 < H) {
          if (x > 0) cov[i + W - 1] += e;
          cov[i + W] += e;
          if (x + 1 < W) cov[i + W + 1] += e;
          if (y + 2 < H) cov[i + 2 * W] += e;
        }
        out[i] = sunPx[i] ? ACC : on ? INK : 0;
      }
    }

    // at night the boat shows her lights: a red and green bicolour at the bow, white at the stern
    if (dark && boat) {
      const rot = Math.atan(bhx) * .7, sc = .075 * ppm, co = Math.cos(rot), si = Math.sin(rot);
      const at = (ux, uy) => [Math.round(bsx + (ux * co - uy * si) * sc), Math.round(bsy + (ux * si + uy * co) * sc)];
      const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) out[y * W + x] = c; };
      const flick = Math.floor(t * 10);
      const [bx, by] = at(29, -8), [sx, sy] = at(-31, -6);
      for (const [lx, ly, col, halo] of [[bx - 1, by, RED, RED_HALO], [bx + 2, by, GREEN, GREEN_HALO], [sx, sy, INK, INK_HALO]]) {
        if (lx < 0 || lx >= W || ly < 0 || ly >= H || vigX[lx] * vigY[ly] < .3) continue;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const r2 = dx * dx + dy * dy;
          if (r2 <= 2) put(lx + dx, ly + dy, col);
          else if (r2 <= 10 && (dx + dy) % 2 === 0) put(lx + dx, ly + dy, halo);
        }
        // the light's reflection, a broken streak wobbling on the swell
        for (let k = 3; k < 40; k++) {
          const y = wl + k;
          if (y >= H) break;
          const x = lx + Math.round(Math.sin(y * 1.3 + t * 2.5) * 2);
          const hsh = ((x * 73856093) ^ (y * 19349663) ^ (flick * 83492791)) >>> 0;
          if ((hsh % 100) / 100 < .85 * (1 - k / 40)) { put(x, y, k < 16 ? col : halo); if (k < 12) put(x + 1, y, halo); }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // redraw at most every 45 ms, and back off further on slow devices
  const nextFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : f => setTimeout(() => f(performance.now()), 16);
  let raf = 0, last = -1e9, gap = 45, visible = true, report = false;
  const loop = ms => {
    raf = 0;
    if (!img) return;
    if (ms - last > gap) {
      last = ms;
      const t0 = performance.now();
      frame(ms);
      gap = Math.min(200, Math.max(45, 2.5 * (performance.now() - t0)));
      if (report) { report = false; onDrawn(); }
    }
    if (visible && !still) raf = nextFrame(loop);
  };
  const kick = () => { if (!raf && img) raf = nextFrame(loop); };
  const refresh = () => { setup(); last = -1e9; kick(); };

  return {
    handle(m) {
      if (m.type === 'size') { size = m; refresh(); }
      else if (m.type === 'theme') { theme = m; report = true; refresh(); }
      else if (m.type === 'visible') { visible = m.visible; kick(); }
      else if (m.type === 'leave') gust.tk = 0;
      else if (m.type === 'pointer' && img) {
        const a = (m.y - HZ) / F;
        if (a < .01) { gust.tk = 0; return; }
        const Z = CAM / a;
        gust.tx = (m.x - cx) / F * Z; gust.tz = Z; gust.tk = 1;
        if (gust.k < .02) { gust.X = gust.tx; gust.Z = gust.tz; }
      }
    },
  };
}

// In a worker, the page hands over the canvas and sends size, theme, visibility and pointer messages.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let sea = null;
  self.onmessage = e => {
    const m = e.data;
    if (m.type === 'init') sea = createSea(m.canvas, m.still, () => self.postMessage({ type: 'drawn' }));
    else if (sea) sea.handle(m);
  };
}
