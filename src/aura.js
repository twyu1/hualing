/**
 * The fingertips are drawn separately from the flower. Each hand owns a ring,
 * a short luminous wake and a small swarm of sparks, so two hands can brush
 * the petals at the same time.
 */

const TAU = Math.PI * 2;

function makeGlowSprite(size, inner, mid) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.12, mid);
  gradient.addColorStop(0.35, mid.replace(/[\d.]+\)$/, '0.12)'));
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export class HandAura {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.states = new Map();
    this.spriteRose = makeGlowSprite(128, 'rgba(255, 246, 249, 0.95)', 'rgba(255, 154, 190, 0.55)');
    this.spriteWhite = makeGlowSprite(128, 'rgba(255, 255, 255, 1)', 'rgba(255, 224, 235, 0.7)');
    this.spriteGold = makeGlowSprite(128, 'rgba(255, 250, 238, 0.95)', 'rgba(255, 206, 154, 0.45)');
    this.resize();
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

  _drawSprite(sprite, x, y, radius, alpha) {
    if (alpha <= 0.001 || radius <= 0) return;
    this.ctx.globalAlpha = clamp(alpha, 0, 1);
    this.ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
  }

  _ensureState(id) {
    let state = this.states.get(id);
    if (!state) {
      state = {
        id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        active: false,
        strength: 1,
        role: 'primary',
        trail: [],
        sparks: [],
        lastSpawn: null,
        openAmount: 0,
        presence: 0,
      };
      this.states.set(id, state);
    }
    return state;
  }

  _spawn(state, pointer) {
    const last = state.lastSpawn;
    const distance = last
      ? Math.hypot(pointer.x - last.x, pointer.y - last.y)
      : 0;
    const speed = Math.min(
      1200,
      Math.hypot(pointer.vx || 0, pointer.vy || 0)
    );

    if (!last || distance > 7) {
      state.trail.push({
        x: pointer.x,
        y: pointer.y,
        life: 1,
        size: 16 + Math.min(34, speed * 0.022),
        seed: Math.random() * TAU,
      });
      state.lastSpawn = { x: pointer.x, y: pointer.y };
      if (state.trail.length > (state.role === 'secondary' ? 20 : 27)) {
        state.trail.shift();
      }
    }

    if (distance > 3 && state.sparks.length < 42) {
      const count = speed > 550 ? 3 : speed > 160 ? 2 : 1;
      const backAngle =
        Math.atan2(pointer.vy || 0, pointer.vx || 0) + Math.PI;
      for (let i = 0; i < count; i += 1) {
        const spread = (Math.random() - 0.5) * 1.4;
        const angle = backAngle + spread;
        const kick = 18 + Math.random() * (22 + Math.min(90, speed * 0.08));
        state.sparks.push({
          x: pointer.x + (Math.random() - 0.5) * 10,
          y: pointer.y + (Math.random() - 0.5) * 10,
          vx: Math.cos(angle) * kick + (pointer.vx || 0) * 0.1,
          vy: Math.sin(angle) * kick + (pointer.vy || 0) * 0.1,
          life: 0.65 + Math.random() * 0.5,
          age: 0,
          size: 1.2 + Math.random() * 2.8,
          gold: Math.random() < 0.32,
        });
      }
    }
  }

  _drawParticles(state, dt, time) {
    const ctx = this.ctx;
    const secondary = state.role === 'secondary';
    const trailSprite = secondary ? this.spriteGold : this.spriteRose;

    for (let i = state.sparks.length - 1; i >= 0; i -= 1) {
      const spark = state.sparks[i];
      spark.age += dt;
      spark.life -= dt * 0.62;
      if (spark.life <= 0) {
        state.sparks.splice(i, 1);
        continue;
      }
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vx *= Math.exp(-dt * 2.4);
      spark.vy *= Math.exp(-dt * 2.4);
      spark.vy -= 2 * dt;
      const fade = Math.min(1, spark.life * 1.5);
      this._drawSprite(
        spark.gold || secondary ? this.spriteGold : this.spriteRose,
        spark.x,
        spark.y,
        spark.size * 3.6,
        fade * 0.36
      );
      this._drawSprite(
        this.spriteWhite,
        spark.x,
        spark.y,
        spark.size * 0.8,
        fade * 0.28
      );
    }

    for (let i = state.trail.length - 1; i >= 0; i -= 1) {
      const point = state.trail[i];
      point.life -= dt * 1.55;
      if (point.life <= 0) {
        state.trail.splice(i, 1);
        continue;
      }
      const fade = point.life * point.life;
      this._drawSprite(
        trailSprite,
        point.x,
        point.y,
        point.size * (1.1 - point.life * 0.2),
        fade * 0.1
      );
      this._drawSprite(
        this.spriteWhite,
        point.x,
        point.y,
        point.size * 0.35,
        fade * 0.08
      );
    }
  }

  _drawReticle(state, time) {
    if (state.presence < 0.01) return;
    const ctx = this.ctx;
    const secondary = state.role === 'secondary';
    const sprite = secondary ? this.spriteGold : this.spriteRose;
    const x = state.x;
    const y = state.y;
    const strength = state.strength ?? 1;
    const openAmount = state.openAmount;
    const breathe = 0.5 + 0.5 * Math.sin(time * 2.1 + (secondary ? 1.7 : 0));
    const outerRadius = 44 + openAmount * 26 + breathe * 3;

    this._drawSprite(
      sprite,
      x,
      y,
      outerRadius * 1.8,
      state.presence * (0.12 + openAmount * 0.1) * strength
    );
    this._drawSprite(
      this.spriteWhite,
      x,
      y,
      outerRadius * 0.32,
      state.presence * 0.25 * strength
    );

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = state.presence * 0.8;

    // A fine, broken orbit — open hands get a wider, faster halo.
    const ringRadius = 20 + openAmount * 15;
    const spin = time * (0.42 + openAmount * 0.3) + (secondary ? 1.2 : 0);
    ctx.lineWidth = 0.85;
    ctx.strokeStyle = secondary
      ? 'rgba(255, 222, 178, 0.5)'
      : 'rgba(255, 203, 222, 0.54)';
    for (let i = 0; i < 3; i += 1) {
      const start = spin + (i * TAU) / 3;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius + i * 2.4, start, start + 0.42);
      ctx.stroke();
    }

    ctx.strokeStyle = secondary
      ? `rgba(255, 231, 198, ${0.14 + openAmount * 0.22})`
      : `rgba(255, 228, 239, ${0.16 + openAmount * 0.25})`;
    ctx.lineWidth = 0.65;
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius + 10 + openAmount * 6, 0, TAU);
    ctx.stroke();

    // Open-hand petals orbiting the hand light.
    if (openAmount > 0.05) {
      for (let i = 0; i < 5; i += 1) {
        const angle = -time * 0.62 + (i * TAU) / 5 + (secondary ? 0.5 : 0);
        const radius = ringRadius + 7 + Math.sin(time * 1.4 + i) * 2;
        const px = Math.cos(angle) * radius;
        const py = Math.sin(angle) * radius * 0.78;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle + Math.PI / 2);
        ctx.beginPath();
        ctx.ellipse(0, 0, 1.6, 4.4, 0, 0, TAU);
        ctx.fillStyle = secondary
          ? `rgba(255, 232, 198, ${0.28 * openAmount * state.presence})`
          : `rgba(255, 217, 232, ${0.3 * openAmount * state.presence})`;
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.beginPath();
    ctx.arc(0, 0, 2.1 + openAmount * 0.7, 0, TAU);
    ctx.fillStyle = secondary
      ? `rgba(255, 246, 230, ${0.5 + openAmount * 0.3})`
      : `rgba(255, 246, 249, ${0.55 + openAmount * 0.3})`;
    ctx.fill();

    ctx.restore();
  }

  update(dt, { pointers = [], time = 0 } = {}) {
    this.resize();
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    const seen = new Set();

    for (const pointer of pointers) {
      if (!pointer || pointer.id == null) continue;
      seen.add(pointer.id);
      const state = this._ensureState(pointer.id);
      state.x = pointer.x;
      state.y = pointer.y;
      state.vx = pointer.vx || 0;
      state.vy = pointer.vy || 0;
      state.strength = pointer.strength ?? 1;
      state.active = pointer.active !== false;
      state.role = pointer.role === 'secondary' ? 'secondary' : 'primary';

      const targetPresence = state.active ? 1 : 0;
      state.presence +=
        (targetPresence - state.presence) * (1 - Math.exp(-dt * 8));
      const targetOpen = pointer.gesture === 'open' ? 1 : 0;
      state.openAmount +=
        (targetOpen - state.openAmount) * (1 - Math.exp(-dt * 6));

      if (state.active) this._spawn(state, pointer);
    }

    for (const [id, state] of this.states) {
      if (!seen.has(id)) {
        state.active = false;
        state.presence += (0 - state.presence) * (1 - Math.exp(-dt * 8));
        state.openAmount +=
          (0 - state.openAmount) * (1 - Math.exp(-dt * 6));
      }
      this._drawParticles(state, dt, time);
      this._drawReticle(state, time);
      if (
        !state.active &&
        state.presence < 0.008 &&
        !state.trail.length &&
        !state.sparks.length
      ) {
        this.states.delete(id);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
