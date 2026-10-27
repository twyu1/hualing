/**
 * Ambient dust behind the flower.  It is intentionally very quiet: soft rose
 * specks, a few out-of-focus bokeh, and slow currents that keep the dark space
 * from feeling like a flat background.
 */

const TAU = Math.PI * 2;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSprite(color, core, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, core);
  gradient.addColorStop(0.08, color);
  gradient.addColorStop(0.28, color.replace(/[\d.]+\)$/, '0.22)'));
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

export class DustField {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
    this.random = mulberry32(77123);
    this.time = 0;
    this.motes = [];
    this.bokeh = [];
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.sprites = {
      rose: makeSprite('rgba(255, 143, 183, 0.62)', 'rgba(255, 241, 246, 0.95)'),
      blush: makeSprite('rgba(255, 191, 211, 0.5)', 'rgba(255, 250, 252, 0.92)'),
      gold: makeSprite('rgba(255, 210, 164, 0.55)', 'rgba(255, 248, 232, 0.96)'),
    };
    this._buildParticles();
    this.resize();
  }

  _buildParticles() {
    const count = window.innerWidth < 700 ? 54 : 86;
    for (let i = 0; i < count; i += 1) {
      const r = this.random();
      this.motes.push({
        x: this.random(),
        y: this.random(),
        size: 1.5 + Math.pow(this.random(), 2.8) * 9,
        alpha: 0.1 + Math.pow(this.random(), 2.2) * 0.42,
        drift: 0.3 + this.random() * 1.5,
        sway: 8 + this.random() * 26,
        phase: this.random() * TAU,
        speed: 0.035 + this.random() * 0.13,
        depth: 0.4 + this.random() * 0.8,
        sprite: r > 0.86 ? 'gold' : r > 0.52 ? 'blush' : 'rose',
      });
    }

    for (let i = 0; i < 6; i += 1) {
      this.bokeh.push({
        x: this.random(),
        y: this.random(),
        radius: 55 + this.random() * 145,
        alpha: 0.018 + this.random() * 0.038,
        phase: this.random() * TAU,
        speed: 0.02 + this.random() * 0.04,
        depth: 0.2 + this.random() * 0.5,
      });
    }
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.15);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(time, pointer = null, orbit = null) {
    this.resize();
    this.time = time;
    const ctx = this.ctx;
    const { w, h } = this;
    const orbitX = orbit
      ? -Math.sin(orbit.yaw || 0) * 24
      : 0;
    const orbitY = orbit
      ? ((orbit.elevation ?? Math.PI * 0.22) - Math.PI * 0.22) * 30
      : 0;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    for (const b of this.bokeh) {
      const pulse = 0.8 + 0.2 * Math.sin(time * 0.24 + b.phase);
      const x = b.x * w + Math.sin(time * b.speed + b.phase) * 18 + orbitX * 0.55;
      const y =
        b.y * h + Math.cos(time * b.speed * 0.7 + b.phase) * 11 + orbitY * 0.55;
      const radius = b.radius * b.depth;
      ctx.globalAlpha = b.alpha * pulse;
      ctx.drawImage(this.sprites.rose, x - radius, y - radius, radius * 2, radius * 2);
    }

    for (const m of this.motes) {
      const t = time * m.speed;
      let x =
        m.x * w +
        Math.sin(t * 1.4 + m.phase) * m.sway * m.depth +
        orbitX * m.depth;
      let y =
        m.y * h +
        Math.cos(t * 0.9 + m.phase * 1.7) * m.sway * 0.45 +
        orbitY * m.depth;
      y -= ((time * m.drift) % (h + 100)) * 0.06;
      if (y < -30) y += h + 60;

      if (pointer?.active) {
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 210 && dist > 0.01) {
          const force = (1 - dist / 210) * 0.8;
          x += (dx / dist) * force * 10;
          y += (dy / dist) * force * 10;
        }
      }

      const flicker =
        0.55 + 0.45 * Math.sin(time * (0.8 + m.speed * 3) + m.phase * 2.1);
      const size = m.size * (1 + 0.08 * Math.sin(time * 0.6 + m.phase));
      ctx.globalAlpha = m.alpha * (0.62 + flicker * 0.38);
      ctx.drawImage(this.sprites[m.sprite], x - size, y - size, size * 2, size * 2);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
