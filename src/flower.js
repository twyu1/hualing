/**
 * The flower is a field of particle sprites and a few soft surface meshes.
 * Every particle knows two positions: the folded bud and the open blossom.
 * A delayed, eased blend between those positions, plus a small outward arc,
 * makes the petals unfurl instead of simply scaling.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;
layout(location = 1) in float aSize;
layout(location = 2) in float aAlpha;
layout(location = 3) in vec3 aColor;
layout(location = 4) in float aGlow;
layout(location = 5) in float aSoft;

uniform vec2 uResolution;
uniform float uDpr;
uniform float uGlowScale;

out vec3 vColor;
out float vAlpha;
out float vGlow;
out float vSoft;

void main() {
  vec2 clip = aPosition / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = max(1.0, aSize * uDpr * uGlowScale);
  vColor = aColor;
  vAlpha = aAlpha;
  vGlow = aGlow;
  vSoft = aSoft;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vColor;
in float vAlpha;
in float vGlow;
in float vSoft;

uniform float uAlphaScale;
out vec4 outColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  float edge = smoothstep(1.0, 0.0, d);
  float body = pow(edge, vSoft);
  float core = pow(max(0.0, 1.0 - d * 2.6), 4.0);
  vec3 white = vec3(1.0, 0.93, 0.96);
  vec3 color = vColor * body + mix(vColor, white, 0.36) * core * vGlow;
  float alpha = vAlpha * uAlphaScale;

  outColor = vec4(color * alpha, alpha);
}
`;

const SURFACE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aAlpha;
uniform vec2 uResolution;
out vec3 vColor;
out float vAlpha;
void main() {
  vec2 clip = aPosition / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
  vAlpha = aAlpha;
}
`;

const SURFACE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  outColor = vec4(vColor * vAlpha, vAlpha);
}
`;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

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

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) / 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function mixRgb(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource = VERTEX_SHADER, fragmentSource = FRAGMENT_SHADER) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${message}`);
  }
  return program;
}

export class FlowerField {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });

    if (!this.gl) {
      throw new Error('WebGL 2 is not available in this browser.');
    }

    this.random = mulberry32(20261027);
    this.particles = [];
    this.bloom = 0;
    this.time = 0;
    this.pressStrength = 0;
    this.pointer = { active: false, x: 0, y: 0, vx: 0, vy: 0, strength: 1 };
    this.orbit = {
      yaw: 0,
      elevation: 40 * DEG,
      offsetX: 0,
      offsetY: 0,
    };
    this.quality = 1;
    this.view = { w: 0, h: 0, cx: 0, cy: 0, scale: 1, dpr: 1 };
    this.buffers = null;
    this.interactRadius = 150;
    this.debug = {
      hideParticles: false,
      hideRibbons: false,
      hideBud: false,
      hideSepals: false,
    };
    this.ribbonsEnabled = false;

    this._setupProgram();
    this.resize();
    this._build();
    this._setupBuffers();
  }

  _setupProgram() {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.uniforms = {
      resolution: gl.getUniformLocation(this.program, 'uResolution'),
      dpr: gl.getUniformLocation(this.program, 'uDpr'),
      glowScale: gl.getUniformLocation(this.program, 'uGlowScale'),
      alphaScale: gl.getUniformLocation(this.program, 'uAlphaScale'),
    };

    this.attributes = {
      position: gl.getAttribLocation(this.program, 'aPosition'),
      size: gl.getAttribLocation(this.program, 'aSize'),
      alpha: gl.getAttribLocation(this.program, 'aAlpha'),
      color: gl.getAttribLocation(this.program, 'aColor'),
      glow: gl.getAttribLocation(this.program, 'aGlow'),
      soft: gl.getAttribLocation(this.program, 'aSoft'),
    };

    this.surfaceProgram = createProgram(
      gl,
      SURFACE_VERTEX_SHADER,
      SURFACE_FRAGMENT_SHADER
    );
    this.surfaceUniforms = {
      resolution: gl.getUniformLocation(this.surfaceProgram, 'uResolution'),
    };
    this.surfaceAttributes = {
      position: gl.getAttribLocation(this.surfaceProgram, 'aPosition'),
      color: gl.getAttribLocation(this.surfaceProgram, 'aColor'),
      alpha: gl.getAttribLocation(this.surfaceProgram, 'aAlpha'),
    };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(h * dpr);

    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }

    const wide = w >= 720;
    const scale = clamp(
      Math.min(w / (wide ? 1120 : 545), h / (wide ? 720 : 800)),
      0.4,
      1.38
    );

    this.view = {
      w,
      h,
      dpr,
      scale,
      cx: w * 0.5,
      cy: h * (wide ? 0.442 : 0.44),
    };
    this.interactRadius = clamp(Math.min(w, h) * 0.185, 88, 190);

    const gl = this.gl;
    gl.viewport(0, 0, pixelW, pixelH);
    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.resolution, w, h);
    gl.uniform1f(this.uniforms.dpr, dpr);
  }

  _setupBuffers() {
    const gl = this.gl;
    this.buffers = {
      vao: gl.createVertexArray(),
      vbo: gl.createBuffer(),
      data: new Float32Array(this.particles.length * 9),
    };

    gl.bindVertexArray(this.buffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = 9 * 4;
    const attrib = (location, size, offset) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
    };

    attrib(this.attributes.position, 2, 0);
    attrib(this.attributes.size, 1, 2);
    attrib(this.attributes.alpha, 1, 3);
    attrib(this.attributes.color, 3, 4);
    attrib(this.attributes.glow, 1, 7);
    attrib(this.attributes.soft, 1, 8);

    gl.bindVertexArray(null);

    let totalVertices = 0;
    let totalIndices = 0;
    for (const surface of this.surfaces) {
      totalVertices += surface.vertexCount;
      totalIndices += surface.indices.length;
    }

    this.surfaceBuffers = {
      vao: gl.createVertexArray(),
      vbo: gl.createBuffer(),
      ebo: gl.createBuffer(),
      data: new Float32Array(totalVertices * 6),
      indices: new Uint16Array(totalIndices),
      vertexCount: 0,
      indexCount: 0,
    };

    gl.bindVertexArray(this.surfaceBuffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.surfaceBuffers.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.surfaceBuffers.data.byteLength,
      gl.DYNAMIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.surfaceBuffers.ebo);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      this.surfaceBuffers.indices.byteLength,
      gl.DYNAMIC_DRAW
    );

    const surfaceStride = 6 * 4;
    const surfaceAttrib = (location, size, offset) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        surfaceStride,
        offset * 4
      );
    };
    surfaceAttrib(this.surfaceAttributes.position, 2, 0);
    surfaceAttrib(this.surfaceAttributes.color, 3, 2);
    surfaceAttrib(this.surfaceAttributes.alpha, 1, 5);
    gl.bindVertexArray(null);

    this.budBuffers = {
      vao: gl.createVertexArray(),
      vbo: gl.createBuffer(),
      ebo: gl.createBuffer(),
      data: new Float32Array(this.budMesh.vertexCount * 6),
    };
    gl.bindVertexArray(this.budBuffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.budBuffers.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.budBuffers.data.byteLength,
      gl.DYNAMIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.budBuffers.ebo);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      this.budMesh.indices,
      gl.STATIC_DRAW
    );
    surfaceAttrib(this.surfaceAttributes.position, 2, 0);
    surfaceAttrib(this.surfaceAttributes.color, 3, 2);
    surfaceAttrib(this.surfaceAttributes.alpha, 1, 5);
    gl.bindVertexArray(null);

    let ribbonVertices = 0;
    let ribbonIndices = 0;
    for (const ribbon of this.ribbons) {
      ribbonVertices += ribbon.samples.length * 5;
      ribbonIndices += (ribbon.samples.length - 1) * 4 * 6;
    }
    const ribbonIndexData = new Uint16Array(ribbonIndices);
    let ribbonCursor = 0;
    let ribbonVertexBase = 0;
    for (const ribbon of this.ribbons) {
      const segments = ribbon.samples.length - 1;
      for (let i = 0; i < segments; i += 1) {
        const current = ribbonVertexBase + i * 5;
        const next = current + 5;
        for (let strip = 0; strip < 4; strip += 1) {
          const a = current + strip;
          const b = a + 1;
          const c = next + strip;
          const d = c + 1;
          ribbonIndexData[ribbonCursor] = a;
          ribbonIndexData[ribbonCursor + 1] = c;
          ribbonIndexData[ribbonCursor + 2] = b;
          ribbonIndexData[ribbonCursor + 3] = b;
          ribbonIndexData[ribbonCursor + 4] = c;
          ribbonIndexData[ribbonCursor + 5] = d;
          ribbonCursor += 6;
        }
      }
      ribbonVertexBase += ribbon.samples.length * 5;
    }

    this.ribbonBuffers = {
      vao: gl.createVertexArray(),
      vbo: gl.createBuffer(),
      ebo: gl.createBuffer(),
      data: new Float32Array(ribbonVertices * 6),
      indexCount: ribbonIndices,
    };
    gl.bindVertexArray(this.ribbonBuffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonBuffers.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.ribbonBuffers.data.byteLength,
      gl.DYNAMIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ribbonBuffers.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ribbonIndexData, gl.STATIC_DRAW);
    surfaceAttrib(this.surfaceAttributes.position, 2, 0);
    surfaceAttrib(this.surfaceAttributes.color, 3, 2);
    surfaceAttrib(this.surfaceAttributes.alpha, 1, 5);
    gl.bindVertexArray(null);

    this.sepalBuffers = {
      vao: gl.createVertexArray(),
      vbo: gl.createBuffer(),
      ebo: gl.createBuffer(),
      data: new Float32Array(this.sepalMesh.vertexCount * 6),
    };
    gl.bindVertexArray(this.sepalBuffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sepalBuffers.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.sepalBuffers.data.byteLength,
      gl.DYNAMIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sepalBuffers.ebo);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      this.sepalMesh.indices,
      gl.STATIC_DRAW
    );
    surfaceAttrib(this.surfaceAttributes.position, 2, 0);
    surfaceAttrib(this.surfaceAttributes.color, 3, 2);
    surfaceAttrib(this.surfaceAttributes.alpha, 1, 5);
    gl.bindVertexArray(null);

    const count = this.particles.length;
    this.offsets = new Float32Array(count * 2);
    this.velocities = new Float32Array(count * 2);
    this.energy = new Float32Array(count);
  }

  _particle(options) {
    this.particles.push({
      bx: options.bud[0],
      by: options.bud[1],
      bz: options.bud[2],
      ox: options.open[0],
      oy: options.open[1],
      oz: options.open[2],
      ax: options.arc ? options.arc[0] : 0,
      ay: options.arc ? options.arc[1] : 0,
      az: options.arc ? options.arc[2] : 0,
      delay: options.delay || 0,
      duration: options.duration || 0.55,
      size: options.size,
      alpha: options.alpha,
      color: options.color,
      glow: options.glow || 0,
      soft: options.soft || 2.4,
      reveal: options.reveal || 0,
      budAlpha: options.budAlpha ?? 1,
      phase: options.phase ?? this.random() * TAU,
      twinkle: options.twinkle || 0,
      ring: options.ring ?? -1,
      layer: options.layer || 0,
      budOnly: !!options.budOnly,
    });
  }

  _build() {
    const area = Math.min(window.innerWidth, window.innerHeight);
    this.quality = area < 520 ? 0.56 : area < 760 ? 0.74 : 1;
    this.particles.length = 0;
    this.surfaces = [];
    this.ribbons = [];
    this._buildBudMesh();
    this._buildPetals();
    this._buildSepals();
    this._buildStem();
    this._buildLeaves();
    this._buildHeart();

    // Opaque silk is drawn first with normal alpha; the sparkle layer is
    // additive and therefore order-independent.  Keeping them contiguous in
    // one buffer lets us switch blend modes between two draw calls.
    this.particles.sort((a, b) => a.layer - b.layer);
    this.bodyCount = this.particles.filter((particle) => particle.layer === 0).length;
    this.glowCount = this.particles.length - this.bodyCount;
  }

  _buildBudMesh() {
    const uSegments = 32;
    const vSegments = 22;
    const cols = uSegments + 1;
    const rows = vSegments + 1;
    const ringCount = rows * cols;
    const vertexCount = ringCount + 1;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);

    const colorDeep = hslToRgb(337, 48, 21);
    const colorMid = hslToRgb(340, 62, 40);
    const colorPale = hslToRgb(344, 72, 69);

    for (let iv = 0; iv < rows; iv += 1) {
      const v = iv / vSegments;
      const profile =
        4 + 54 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.9)), 0.92);
      const z = -4 + 200 * v + 1.6 * Math.sin(v * Math.PI);
      const leanX = 12 * v * v + 1.5 * Math.sin(v * 4.2);
      const leanY = 4 * v * v;

      for (let iu = 0; iu < cols; iu += 1) {
        const phi = (iu / uSegments) * TAU;
        const ridge = 1 + 0.09 * Math.cos(7 * phi + v * 1.8);
        const radius = profile * ridge;
        const index = iv * cols + iu;
        const offset = index * 3;
        positions[offset] = Math.cos(phi) * radius + leanX;
        positions[offset + 1] = Math.sin(phi) * radius * 0.92 + leanY;
        positions[offset + 2] = z;

        let color = mixRgb(colorDeep, colorMid, smoothstep(0.02, 0.56, v));
        color = mixRgb(
          color,
          colorPale,
          smoothstep(0.52, 1, v) * 0.46
        );
        const front = 0.5 + 0.5 * Math.cos(phi - 0.25);
        const shade = 0.34 + 0.66 * front + 0.12 * Math.sin(v * Math.PI);
        const ridgeLight =
          0.7 + 0.3 * (0.5 + 0.5 * Math.cos(7 * phi + v * 2.1 + 0.8));
        colors[offset] = clamp(color[0] * shade * ridgeLight, 0, 1);
        colors[offset + 1] = clamp(color[1] * shade * ridgeLight, 0, 1);
        colors[offset + 2] = clamp(color[2] * shade * ridgeLight, 0, 1);
        alphas[index] = clamp(0.8 + 0.14 * front + 0.04 * v, 0, 0.98);
      }
    }

    // Close the top of the bud with a small pale cap.
    const capIndex = ringCount;
    const capOffset = capIndex * 3;
    positions[capOffset] = 12;
    positions[capOffset + 1] = 4;
    positions[capOffset + 2] = 199;
    const capColor = mixRgb(colorPale, [1, 0.84, 0.68], 0.4);
    colors[capOffset] = capColor[0];
    colors[capOffset + 1] = capColor[1];
    colors[capOffset + 2] = capColor[2];
    alphas[capIndex] = 0.95;

    const indices = [];
    for (let iv = 0; iv < vSegments; iv += 1) {
      for (let iu = 0; iu < uSegments; iu += 1) {
        const a = iv * cols + iu;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    for (let iu = 0; iu < uSegments; iu += 1) {
      const a = vSegments * cols + iu;
      const b = a + 1;
      indices.push(a, b, capIndex);
    }

    this.budMesh = {
      positions,
      colors,
      alphas,
      indices: new Uint16Array(indices),
      vertexCount,
      indexCount: indices.length,
      fade: 1,
    };

    // A dusting of light on the closed bud makes the solid form read as a
    // particle sculpture rather than a smooth shell.
    const dustCount = Math.max(200, Math.round(620 * this.quality));
    for (let i = 0; i < dustCount; i += 1) {
      const index = Math.floor(this.random() * ringCount);
      const offset = index * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      const radial = Math.hypot(x - 12, y - 4) || 1;
      const push = mix(0.8, 3.2, this.random());
      const point = [
        x + ((x - 12) / radial) * push,
        y + ((y - 4) / radial) * push,
        z + (this.random() - 0.5) * 2,
      ];
      const baseColor = [
        colors[offset],
        colors[offset + 1],
        colors[offset + 2],
      ];
      const color = mixRgb(
        mixRgb(baseColor, [1, 0.74, 0.84], 0.2),
        [1, 0.9, 0.78],
        this.random() < 0.16 ? 0.5 : 0
      );
      this._particle({
        bud: point,
        open: point,
        size: mix(0.75, 2.4, this.random()),
        alpha: mix(0.12, 0.52, this.random()),
        color,
        glow: mix(0.15, 0.7, this.random()),
        soft: mix(1.8, 2.6, this.random()),
        twinkle: mix(0.18, 0.5, this.random()),
        layer: 1,
        budOnly: true,
        phase: this.random() * TAU,
      });
    }

    // Three quiet seam lines suggest the petals folded inside the bud.
    for (const [seam, phiBase] of [
      [0, -0.72],
      [1, 0.02],
      [2, 0.76],
    ]) {
      const steps = 30;
      for (let i = 0; i <= steps; i += 1) {
        const v = 0.07 + (i / steps) * 0.88;
        const profile =
          4 + 54 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.9)), 0.92);
        const phi = phiBase + Math.sin(v * 2.2 + seam) * 0.16;
        const z = -4 + 200 * v + 1.6 * Math.sin(v * Math.PI);
        const point = [
          Math.cos(phi) * (profile + 1.8) + 12 * v * v,
          Math.sin(phi) * (profile + 1.8) * 0.92 + 4 * v * v,
          z,
        ];
        this._particle({
          bud: point,
          open: point,
          size: mix(0.9, 2.4, this.random()),
          alpha:
            (seam === 1 ? mix(0.25, 0.6, this.random()) : mix(0.12, 0.38, this.random())) *
            (0.5 + 0.5 * smoothstep(0.04, 0.4, v)),
          color: seam === 1
            ? mixRgb([1, 0.8, 0.89], [1, 0.91, 0.76], 0.35)
            : mixRgb(colorPale, [1, 0.76, 0.86], 0.45),
          glow: seam === 1 ? 0.35 : 0.18,
          soft: 2.2,
          twinkle: 0.12,
          layer: 1,
          budOnly: true,
          phase: this.random() * TAU,
        });
      }
    }

    // Warm rim light along the front edge of the bud.
    for (let i = 0; i < Math.round(90 * this.quality); i += 1) {
      const v = 0.08 + this.random() * 0.88;
      const profile =
        4 + 54 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.9)), 0.92);
      const phi = 0.1 + (this.random() - 0.5) * 0.5;
      const z = -4 + 200 * v + 1.6 * Math.sin(v * Math.PI);
      const point = [
        Math.cos(phi) * (profile + 1.6) + 12 * v * v,
        Math.sin(phi) * (profile + 1.6) * 0.92 + 4 * v * v,
        z,
      ];
      this._particle({
        bud: point,
        open: point,
        size: mix(0.9, 2.8, this.random()),
        alpha: mix(0.2, 0.58, this.random()),
        color: mixRgb([1, 0.76, 0.87], [1, 0.9, 0.74], this.random() * 0.4),
        glow: mix(0.3, 0.9, this.random()),
        soft: mix(1.7, 2.4, this.random()),
        twinkle: mix(0.2, 0.55, this.random()),
        layer: 1,
        budOnly: true,
        phase: this.random() * TAU,
      });
    }
  }

  _petalRings() {
    return [
      {
        count: 7,
        offset: 0.2,
        length: [228, 268],
        width: [126, 152],
        openPitch: [12, 23],
        budPitch: [73, 84],
        delay: [0.0, 0.1],
        baseZ: -4,
        baseRadius: 10,
        budWidth: 0.55,
        arch: [14, 26],
        edgeLift: [8, 15],
        wave: [5, 10],
        openCurl: [-11, -2],
        budCurl: [3, 9],
        edgeAlpha: 1.3,
        fillAlpha: 0.25,
        colorBase: hslToRgb(340, 58, 43),
        colorMid: hslToRgb(344, 86, 64),
        colorTip: hslToRgb(350, 100, 88),
        surfaceAlpha: 0.56,
        quality: 1,
      },
      {
        count: 5,
        offset: 1.02,
        length: [168, 202],
        width: [104, 126],
        openPitch: [31, 42],
        budPitch: [69, 80],
        delay: [0.12, 0.24],
        baseZ: 8,
        baseRadius: 9,
        budWidth: 0.47,
        arch: [16, 27],
        edgeLift: [6, 12],
        wave: [4, 9],
        openCurl: [-6, 3],
        budCurl: [3, 8],
        edgeAlpha: 0.95,
        fillAlpha: 0.3,
        colorBase: hslToRgb(337, 72, 33),
        colorMid: hslToRgb(343, 96, 54),
        colorTip: hslToRgb(349, 100, 79),
        surfaceAlpha: 0.64,
        quality: 0.98,
      },
      {
        count: 4,
        offset: 1.75,
        length: [112, 148],
        width: [76, 100],
        openPitch: [46, 58],
        budPitch: [66, 77],
        delay: [0.23, 0.34],
        baseZ: 15,
        baseRadius: 8,
        budWidth: 0.42,
        arch: [12, 22],
        edgeLift: [5, 9],
        wave: [3, 7],
        openCurl: [0, 8],
        budCurl: [2, 7],
        edgeAlpha: 0.55,
        fillAlpha: 0.34,
        colorBase: hslToRgb(335, 64, 28),
        colorMid: hslToRgb(341, 86, 46),
        colorTip: hslToRgb(347, 96, 67),
        surfaceAlpha: 0.7,
        quality: 0.95,
      },
    ];
  }

  _buildPetals() {
    const rings = this._petalRings();
    const quality = this.quality;

    rings.forEach((ring, ringIndex) => {
      ring.ringIndex = ringIndex;
      for (let i = 0; i < ring.count; i += 1) {
        const angle =
          (i / ring.count) * TAU + ring.offset + (this.random() - 0.5) * 0.19;
        const length = mix(ring.length[0], ring.length[1], this.random());
        const width = mix(ring.width[0], ring.width[1], this.random());
        const delay = mix(ring.delay[0], ring.delay[1], this.random());
        const petal = {
          angle,
          length,
          width,
          pitch: mix(ring.openPitch[0], ring.openPitch[1], this.random()) + (this.random() - 0.5) * 7,
          budPitch: mix(ring.budPitch[0], ring.budPitch[1], this.random()) + (this.random() - 0.5) * 5,
          openCurl: mix(ring.openCurl[0], ring.openCurl[1], this.random()),
          budCurl: mix(ring.budCurl[0], ring.budCurl[1], this.random()),
          baseZ: ring.baseZ + (this.random() - 0.5) * 4,
          baseRadius: ring.baseRadius + this.random() * 3,
          budWidth: ring.budWidth * mix(0.92, 1.08, this.random()),
          arch: mix(ring.arch[0], ring.arch[1], this.random()),
          edgeLift: mix(ring.edgeLift[0], ring.edgeLift[1], this.random()),
          wave: mix(ring.wave[0], ring.wave[1], this.random()),
          twist: (this.random() - 0.5) * 0.12,
          budTwist: (this.random() - 0.5) * 0.34,
          leanX: (this.random() - 0.5) * 8,
          leanY: (this.random() - 0.5) * 8,
          phase: this.random() * TAU,
          delay,
          ringIndex,
          colorBase: ring.colorBase,
          colorMid: ring.colorMid,
          colorTip: ring.colorTip,
        };

        this._samplePetal(petal, ring, quality);
        this._buildPetalSurface(petal, ring);
        this._buildPetalRibbons(petal, ring);
      }
    });
  }

  _buildPetalRibbons(petal, ring) {
    const segments = 30;
    for (const side of [-1, 1]) {
      const samples = [];
      for (let i = 0; i <= segments; i += 1) {
        const v = 0.12 + (i / segments) * 0.86;
        const u = side * 0.985;
        const bud = this._petalPoint(petal, v, u, false);
        const open = this._petalPoint(petal, v, u, true);
        const warm = this.random() < 0.14;
        let color = mixRgb(
          petal.colorMid,
          petal.colorTip,
          0.42 + smoothstep(0.12, 0.92, v) * 0.48
        );
        if (warm) color = mixRgb(color, [1, 0.82, 0.66], 0.34);
        samples.push({
          v,
          bud,
          open,
          color,
          alpha:
            mix(0.34, 0.78, smoothstep(0.1, 0.86, v)) *
            mix(0.9, 1.1, this.random()),
        });
      }
      this.ribbons.push({ petal, ring, side, samples, delay: petal.delay });
    }
  }

  _buildPetalSurface(petal, ring) {
    const vSegments = 12;
    const uSegments = 10;
    const cols = uSegments + 1;
    const rows = vSegments + 1;
    const vertexCount = rows * cols;
    const vertices = {
      bud: new Float32Array(vertexCount * 3),
      open: new Float32Array(vertexCount * 3),
      color: new Float32Array(vertexCount * 3),
      alpha: new Float32Array(vertexCount),
      light: new Float32Array(vertexCount * 2),
    };
    const facing = 0.66 + 0.34 * (Math.sin(petal.angle) * 0.5 + 0.5);
    const tint = mix(0.9, 1.1, this.random()) * facing;
    const opacity = mix(0.86, 1.08, this.random());
    const lightDirection = [-0.3, -0.24, 0.92];
    const lightLength = Math.hypot(...lightDirection);
    lightDirection[0] /= lightLength;
    lightDirection[1] /= lightLength;
    lightDirection[2] /= lightLength;

    const brightnessAt = (v, u, isOpen) => {
      const p0 = this._petalPoint(petal, v, u, isOpen);
      const pv = this._petalPoint(
        petal,
        Math.min(0.985, v + 0.035),
        u,
        isOpen
      );
      const pu = this._petalPoint(
        petal,
        v,
        Math.min(0.985, u + 0.035),
        isOpen
      );
      const ax = pv[0] - p0[0];
      const ay = pv[1] - p0[1];
      const az = pv[2] - p0[2];
      const bx = pu[0] - p0[0];
      const by = pu[1] - p0[1];
      const bz = pu[2] - p0[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      if (nz < 0) {
        nx *= -1;
        ny *= -1;
        nz *= -1;
      }
      const diffuse = Math.abs(
        nx * lightDirection[0] +
          ny * lightDirection[1] +
          nz * lightDirection[2]
      );
      return 0.58 + 0.42 * diffuse;
    };

    for (let iv = 0; iv < rows; iv += 1) {
      const v = 0.015 + (iv / vSegments) * 0.97;
      for (let iu = 0; iu < cols; iu += 1) {
        const edge = -1 + (iu / uSegments) * 2;
        const u = edge * 0.985;
        const bud = this._petalPoint(petal, v, u, false);
        const open = this._petalPoint(petal, v, u, true);
        const index = iv * cols + iu;
        const offset = index * 3;
        vertices.bud[offset] = bud[0];
        vertices.bud[offset + 1] = bud[1];
        vertices.bud[offset + 2] = bud[2];
        vertices.open[offset] = open[0];
        vertices.open[offset + 1] = open[1];
        vertices.open[offset + 2] = open[2];

        let color = mixRgb(
          ring.colorBase,
          ring.colorMid,
          0.42 + v * 0.48
        );
        color = mixRgb(color, ring.colorTip, smoothstep(0.26, 1, v) * 0.68);
        color = mixRgb(color, ring.colorBase, Math.pow(Math.abs(edge), 3) * 0.14);
        const sheen =
          (0.76 + 0.24 * (1 - Math.abs(edge))) *
          (0.9 + 0.1 * ((edge + 1) * 0.5));
        color = color.map((channel) => clamp(channel * tint * sheen, 0, 1));

        const edgeFade =
          0.03 + 0.97 * (1 - smoothstep(0.55, 1, Math.abs(edge)));
        const baseFade =
          (0.3 + 0.7 * smoothstep(0.01, 0.48, v)) *
          (1 - 0.2 * smoothstep(0.72, 1, v));
        vertices.color[offset] = color[0];
        vertices.color[offset + 1] = color[1];
        vertices.color[offset + 2] = color[2];
        vertices.alpha[index] =
          ring.surfaceAlpha * edgeFade * baseFade * opacity;
        vertices.light[index * 2] = brightnessAt(v, u, false);
        vertices.light[index * 2 + 1] = brightnessAt(v, u, true);
      }
    }

    const indices = new Uint16Array(vSegments * uSegments * 6);
    let cursor = 0;
    for (let iv = 0; iv < vSegments; iv += 1) {
      for (let iu = 0; iu < uSegments; iu += 1) {
        const a = iv * cols + iu;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices[cursor] = a;
        indices[cursor + 1] = c;
        indices[cursor + 2] = b;
        indices[cursor + 3] = b;
        indices[cursor + 4] = c;
        indices[cursor + 5] = d;
        cursor += 6;
      }
    }

    const centerIndex = Math.floor(rows * 0.55) * cols + Math.floor(cols / 2);
    const centerOffset = centerIndex * 3;
    const arcAngle = petal.angle;
    const arcAmount = 9 + this.random() * 5;
    this.surfaces.push({
      petal,
      ring,
      vertices,
      indices,
      cols,
      rows,
      vertexCount,
      delay: petal.delay + 0.01,
      duration: 0.56,
      budAlpha: 0,
      centerBud: [
        vertices.bud[centerOffset],
        vertices.bud[centerOffset + 1],
        vertices.bud[centerOffset + 2],
      ],
      centerOpen: [
        vertices.open[centerOffset],
        vertices.open[centerOffset + 1],
        vertices.open[centerOffset + 2],
      ],
      centerArc: [
        Math.cos(arcAngle) * arcAmount,
        Math.sin(arcAngle) * arcAmount,
        6 + this.random() * 6,
      ],
      sortDepth: 0,
    });
  }

  _petalPoint(petal, v, u, open) {
    const shape =
      Math.pow(Math.sin(Math.PI * Math.pow(v, 0.6)), 0.48) * (0.64 + 0.36 * v);
    const widthFactor = open ? 1 : petal.budWidth;
    const lateral = u * petal.width * widthFactor * shape;
    const radial =
      petal.baseRadius + v * petal.length * (open ? 1 : 0.86);
    const arch =
      petal.arch * Math.sin(Math.PI * v) +
      petal.edgeLift * u * u * v * (open ? 1 : 0.3);
    const wave =
      petal.wave *
      Math.sin(v * 5.4 + u * 2.1 + petal.phase) *
      v *
      (open ? 1 : 0.23);
    const pitch = (open ? petal.pitch : petal.budPitch) +
      (open ? petal.openCurl : petal.budCurl) * v * v;
    const theta = pitch * DEG;
    const spin =
      petal.angle +
      petal.twist * v * (open ? 1 : 0.5) +
      (open ? 0 : petal.budTwist * v);
    const localZ = arch + wave;
    const radialX = radial * Math.cos(theta) - localZ * Math.sin(theta);
    let z = petal.baseZ + radial * Math.sin(theta) + localZ * Math.cos(theta);

    let x = radialX * Math.cos(spin) - lateral * Math.sin(spin);
    let y = radialX * Math.sin(spin) + lateral * Math.cos(spin);

    if (!open) {
      x += petal.leanX * v * v;
      y += petal.leanY * v * v;
      z += 5 * Math.sin(Math.PI * v) * (petal.ringIndex === 0 ? 0.6 : 1);
    }

    return [x, y, z];
  }

  _samplePetal(petal, ring, quality) {
    const sample = (v, u, kind, index) => {
      v = clamp(v, 0.015, 0.995);
      u = clamp(u, -0.995, 0.995);
      const bud = this._petalPoint(petal, v, u, false);
      const open = this._petalPoint(petal, v, u, true);

      const jitter = 0.65;
      bud[0] += (this.random() - 0.5) * jitter;
      bud[1] += (this.random() - 0.5) * jitter;
      bud[2] += (this.random() - 0.5) * jitter;
      open[0] += (this.random() - 0.5) * jitter;
      open[1] += (this.random() - 0.5) * jitter;
      open[2] += (this.random() - 0.5) * jitter;

      const arcAmount =
        (kind === "edge" ? 9 : kind === "haze" ? 11 : 5) *
        mix(0.55, 1.35, this.random());
      const arc = [
        Math.cos(petal.angle) * arcAmount,
        Math.sin(petal.angle) * arcAmount,
        5 + this.random() * 8,
      ];

      let color;
      let alpha;
      let size;
      let glow;
      let soft;
      let twinkle;

      if (kind === "edge") {
        color = mixRgb(
          mixRgb(petal.colorBase, petal.colorMid, 0.74),
          petal.colorTip,
          0.2 + this.random() * 0.36 + v * 0.05
        );
        if (this.random() < 0.16) {
          color = mixRgb(color, [1, 0.82, 0.67], 0.26 + this.random() * 0.18);
        }
        alpha =
          ring.edgeAlpha *
          mix(0.8, 1.15, this.random()) *
          (0.2 + 0.8 * smoothstep(0.1, 0.46, v)) *
          0.22;
        size = mix(1.6, 3.6, this.random()) * mix(0.9, 1.25, v);
        glow = mix(0.12, 0.42, this.random());
        soft = mix(1.95, 2.55, this.random());
        twinkle = mix(0.06, 0.2, this.random());
      } else if (kind === "rim") {
        color = mixRgb(
          petal.colorMid,
          this.random() < 0.24 ? [1, 0.84, 0.7] : petal.colorTip,
          mix(0.4, 0.8, this.random())
        );
        alpha =
          mix(0.05, 0.14, this.random()) *
          (0.25 + 0.75 * smoothstep(0.1, 0.5, v)) *
          0.22 *
          [1, 0.55, 0.2][ring.ringIndex];
        size = mix(8, 23, this.random());
        glow = 0.12;
        soft = mix(1.35, 1.75, this.random());
        twinkle = 0.05;
      } else if (kind === "vein") {
        color = mixRgb(
          petal.colorMid,
          petal.colorTip,
          0.3 + v * 0.48 + this.random() * 0.12
        );
        alpha = ring.fillAlpha * mix(0.95, 1.9, this.random());
        size = mix(1.0, 2.2, this.random());
        glow = 0.03;
        soft = 2.55;
        twinkle = 0.05;
      } else if (kind === "glint") {
        color = mixRgb(petal.colorTip, [1, 0.9, 0.94], mix(0.2, 0.48, this.random()));
        alpha = mix(0.34, 0.72, this.random());
        size = mix(1.6, 3.2, this.random());
        glow = mix(0.32, 0.82, this.random());
        soft = mix(1.8, 2.35, this.random());
        twinkle = mix(0.25, 0.62, this.random());
      } else if (kind === "haze") {
        color = mixRgb(petal.colorMid, petal.colorTip, mix(0.15, 0.55, this.random()));
        alpha = mix(0.014, 0.034, this.random());
        size = mix(17, 42, this.random());
        glow = 0;
        soft = mix(1.5, 1.9, this.random());
        twinkle = 0.03;
      } else {
        color = mixRgb(
          mixRgb(petal.colorBase, petal.colorMid, mix(0.55, 0.9, this.random())),
          petal.colorTip,
          mix(0.1, 0.36, this.random()) + v * 0.12
        );
        alpha = ring.fillAlpha * mix(0.52, 1.7, this.random()) * mix(0.8, 1.1, v);
        size = mix(1.2, 2.7, this.random());
        if (this.random() < 0.06) {
          size *= 2.8;
          alpha *= 0.55;
        }
        glow = 0;
        soft = 3.0;
        twinkle = 0.06;
      }

      if (kind === "fill" && this.random() < 0.07) {
        alpha *= 0.5;
      }

      const facing = 0.68 + 0.32 * (Math.sin(petal.angle) * 0.5 + 0.5);
      alpha *= facing;

      const ringBudVisibility = [0, 0, 0][ring.ringIndex] ?? 1;
      let budAlpha = ringBudVisibility;
      if (kind === "haze") {
        budAlpha = [0, 0, 0][ring.ringIndex] ?? 0;
      } else if (kind === "glint") {
        budAlpha = ringBudVisibility * 0.46;
      } else if (kind === "rim") {
        budAlpha = ringBudVisibility * 0.58;
      } else if (kind === "fill" || kind === "vein") {
        budAlpha = ringBudVisibility * 0.9;
      }

      const delay =
        petal.delay +
        this.random() * 0.075 +
        (kind === "glint" ? 0.02 : 0) +
        (ring.ringIndex === 3 ? 0.015 : 0);

      this._particle({
        bud,
        open,
        arc,
        delay,
        duration: mix(0.46, 0.62, this.random()),
        size,
        alpha,
        color,
        glow,
        soft,
        budAlpha,
        layer: kind === "glint" || kind === "rim" ? 1 : 0,
        phase: this.random() * TAU,
        twinkle,
        ring: ring.ringIndex,
      });
    };

    const q = quality * ring.quality;

    // Dense, bright outline.  This is what gives each petal a readable edge.
    const edgeSteps = Math.max(18, Math.round(64 * q));
    for (const side of [-1, 1]) {
      for (let i = 0; i < edgeSteps; i += 1) {
        const v = 0.14 + (i / (edgeSteps - 1)) * 0.84;
        const u = side * (0.974 + (this.random() - 0.5) * 0.032);
        sample(v, u, "edge", i);
        if (i % 8 === 0) {
          sample(v, u * 0.99, "rim", i);
        }
      }
    }

    // A handful of interior veins stop the petals reading as flat blobs.
    const veinCount = Math.max(5, Math.round(8 * q));
    const veinSteps = Math.max(6, Math.round(12 * q));
    for (let line = 0; line < veinCount; line += 1) {
      const baseU = veinCount === 1 ? 0 : -0.72 + (line / (veinCount - 1)) * 1.44;
      for (let i = 0; i < veinSteps; i += 1) {
        const v = 0.08 + (i / Math.max(1, veinSteps - 1)) * 0.82;
        const u = baseU * (0.86 + this.random() * 0.15) * (0.94 + v * 0.06);
        sample(v, u, "vein", i);
      }
    }

    // Dense, quasi-even dusting.  A little stratification keeps the surface
    // from clumping into bright knots.
    const fillCount = Math.max(48, Math.round(220 * q));
    for (let i = 0; i < fillCount; i += 1) {
      const v =
        0.045 +
        ((i * 0.61803398875 + this.random() * 0.055) % 1) * 0.925;
      const lateralSeed = (i * 0.7548776662 + this.random() * 0.07) % 1;
      const u = (lateralSeed * 2 - 1) * 0.87;
      sample(v, u, "fill", i);
    }

    // Small silk-glow sprites add a few soft breaths of light inside the dust.
    const hazeCount = Math.max(2, Math.round(4 * q));
    for (let i = 0; i < hazeCount; i += 1) {
      const v = 0.2 + this.random() * 0.6;
      const u = (this.random() * 2 - 1) * 0.58;
      sample(v, u, "haze", i);
    }

    // Tiny dew-like sparks along the rim.
    const glints = Math.max(3, Math.round(10 * q));
    for (let i = 0; i < glints; i += 1) {
      const v = 0.13 + this.random() * 0.8;
      const u = (this.random() * 2 - 1) * 0.93;
      sample(v, u, "glint", i);
    }
  }

  _buildSepalMesh() {
    const sepalCount = 5;
    const uSegments = 8;
    const vSegments = 14;
    const cols = uSegments + 1;
    const rows = vSegments + 1;
    const perSepal = rows * cols;
    const vertexCount = sepalCount * perSepal;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);
    const indices = [];

    const deep = hslToRgb(334, 48, 19);
    const mid = hslToRgb(338, 52, 31);
    const rim = hslToRgb(342, 50, 40);
    const vein = hslToRgb(342, 38, 37);

    for (let s = 0; s < sepalCount; s += 1) {
      const angle = (s / sepalCount) * TAU + 0.28;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const lateralX = -sinA;
      const lateralY = cosA;

      for (let iv = 0; iv < rows; iv += 1) {
        const t = iv / vSegments;
        const radial = 8 + 58 * t;
        const z = -2 - 40 * Math.pow(t, 1.25) + 5 * Math.sin(t * Math.PI);
        const width = 14 * Math.pow(Math.sin(Math.PI * t), 0.72) + 1.2;
        const centerX = cosA * radial + 5 * t * t;
        const centerY = sinA * radial * 0.8;

        for (let iu = 0; iu < cols; iu += 1) {
          const lateral = -1 + (iu / uSegments) * 2;
          const index = s * perSepal + iv * cols + iu;
          const offset = index * 3;
          positions[offset] = centerX + lateralX * lateral * width;
          positions[offset + 1] =
            centerY + lateralY * lateral * width + Math.sin(t * 4) * 0.8;
          positions[offset + 2] =
            z + Math.sin(Math.PI * t) * Math.abs(lateral) * 5;

          let color = mixRgb(deep, mid, 0.25 + t * 0.6);
          color = mixRgb(color, rim, Math.pow(Math.abs(lateral), 1.6) * 0.55);
          if (Math.abs(lateral) < 0.18) {
            color = mixRgb(color, vein, 0.55);
          }
          colors[offset] = color[0];
          colors[offset + 1] = color[1];
          colors[offset + 2] = color[2];
          alphas[index] =
            0.72 +
            0.22 * smoothstep(0.05, 0.8, t) -
            0.18 * Math.pow(Math.abs(lateral), 3);
        }
      }

      for (let iv = 0; iv < vSegments; iv += 1) {
        for (let iu = 0; iu < uSegments; iu += 1) {
          const a = s * perSepal + iv * cols + iu;
          const b = a + 1;
          const c = a + cols;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
    }

    this.sepalMesh = {
      positions,
      colors,
      alphas,
      indices: new Uint16Array(indices),
      vertexCount,
      indexCount: indices.length,
    };
  }

  _buildSepals() {
    this._buildSepalMesh();
    const quality = this.quality;
    const amount = Math.max(24, Math.round(52 * quality));
    for (let s = 0; s < 5; s += 1) {
      const angle = (s / 5) * TAU + 0.22;
      const length = 52 + this.random() * 14;
      const width = 20 + this.random() * 8;
      const colorBase = hslToRgb(338, 50, 26);
      const colorTip = hslToRgb(344, 62, 47);

      for (let i = 0; i < amount; i += 1) {
        const t = 0.06 + this.random() * 0.92;
        const u = (this.random() * 2 - 1) * 0.92;
        const shape = Math.pow(Math.sin(Math.PI * t), 0.7);
        const lateral = u * width * shape;
        const radial = 5 + t * length;
        const budPitch = (-34 + t * 10) * DEG;
        const openPitch = (-54 + t * 9) * DEG;

        const point = (pitch, zBase, spread) => {
          const rr = radial * Math.cos(pitch);
          const z = zBase + radial * Math.sin(pitch) + 2 * Math.sin(t * Math.PI);
          const a = angle + spread * t;
          return [
            rr * Math.cos(a) - lateral * Math.sin(a),
            rr * Math.sin(a) + lateral * Math.cos(a),
            z,
          ];
        };

        const bud = point(budPitch, -2, 0.04);
        const open = point(openPitch, -3, 0.2);
        const nearEdge = Math.abs(u) > 0.78;
        this._particle({
          bud,
          open,
          arc: [
            Math.cos(angle) * (nearEdge ? 9 : 5),
            Math.sin(angle) * (nearEdge ? 9 : 5),
            3,
          ],
          delay: 0.03 + this.random() * 0.1,
          duration: 0.48,
          size: nearEdge ? mix(1.0, 2.4, this.random()) : mix(0.75, 1.7, this.random()),
          alpha: nearEdge ? mix(0.28, 0.58, this.random()) : mix(0.08, 0.24, this.random()),
          color: mixRgb(colorBase, colorTip, t * 0.75 + this.random() * 0.25),
          glow: nearEdge ? 0.15 : 0.02,
          soft: 2.7,
          twinkle: 0.06,
          phase: this.random() * TAU,
        });
      }

    }
  }

  _buildStem() {
    const count = Math.max(170, Math.round(300 * this.quality));
    const colorA = hslToRgb(338, 42, 34);
    const colorB = hslToRgb(346, 56, 49);

    for (let i = 0; i < count; i += 1) {
      const t = this.random();
      const z = -342 + t * 338;
      const bend =
        19 * Math.sin((1 - t) * Math.PI * 0.76) + 3.2 * Math.sin(t * 11.5);
      const radius = Math.pow(this.random(), 1.8) * 3.1;
      const a = this.random() * TAU;
      const x = bend + Math.cos(a) * radius;
      const y = Math.sin(a) * radius * 0.85;
      const point = [x, y, z + (this.random() - 0.5) * 1.8];
      const dew = i % 23 === 0;
      this._particle({
        bud: point,
        open: point,
        size: dew ? mix(1.6, 2.6, this.random()) : mix(0.75, 1.75, this.random()),
        alpha: dew
          ? mix(0.42, 0.7, this.random())
          : mix(0.16, 0.46, this.random()),
        color: dew
          ? hslToRgb(350, 72, 69)
          : mixRgb(colorA, colorB, t * 0.65 + this.random() * 0.35),
        glow: dew ? 0.28 : 0.015,
        soft: dew ? 2.15 : 2.75,
        twinkle: dew ? 0.18 : 0.025,
        layer: dew ? 1 : 0,
        phase: this.random() * TAU,
      });
    }

    // A small, darker collar where the flower meets the stem.
    for (let i = 0; i < Math.round(38 * this.quality); i += 1) {
      const a = this.random() * TAU;
      const r = 4 + this.random() * 16;
      const z = -5 + this.random() * 14;
      const point = [Math.cos(a) * r, Math.sin(a) * r * 0.6, z];
      this._particle({
        bud: point,
        open: point,
        size: mix(0.9, 2.2, this.random()),
        alpha: mix(0.12, 0.38, this.random()),
        color: mixRgb(hslToRgb(340, 48, 28), hslToRgb(344, 58, 39), this.random()),
        glow: 0.02,
        soft: 2.8,
        twinkle: 0.03,
        phase: this.random() * TAU,
      });
    }
  }

  _buildLeaves() {
    const leafSets = [
      {
        base: [13, 0, -258],
        direction: 1,
        length: 128,
        width: 34,
        lift: 61,
        droop: 16,
      },
      {
        base: [-8, 1, -314],
        direction: -1,
        length: 96,
        width: 27,
        lift: 43,
        droop: 10,
      },
    ];
    const colorBase = hslToRgb(338, 37, 27);
    const colorEdge = hslToRgb(342, 56, 46);
    const colorLight = hslToRgb(348, 76, 63);
    const q = this.quality;

    for (const leaf of leafSets) {
      const [bx, by, bz] = leaf.base;
      const outlineSteps = Math.max(16, Math.round(40 * q));
      const innerSteps = Math.max(12, Math.round(30 * q));
      const veinSteps = Math.max(8, Math.round(16 * q));

      const leafPoint = (t, w) => {
        const centerX = bx + leaf.direction * leaf.length * t;
        const centerZ =
          bz + leaf.lift * Math.sin(t * Math.PI * 0.72) - leaf.droop * t * t;
        const halfWidth = leaf.width * Math.pow(Math.sin(Math.PI * t), 0.82) + 1;
        const tangentX = leaf.direction * leaf.length;
        const tangentZ =
          leaf.lift * 0.72 * Math.PI * Math.cos(t * Math.PI * 0.72) -
          2 * leaf.droop * t;
        const len = Math.hypot(tangentX, tangentZ) || 1;
        const nx = -tangentZ / len;
        const nz = tangentX / len;
        return [
          centerX + nx * w * halfWidth,
          by + (this.random() - 0.5) * 2.8,
          centerZ + nz * w * halfWidth,
        ];
      };

      for (const side of [-1, 1]) {
        for (let i = 0; i < outlineSteps; i += 1) {
          const t = 0.035 + (i / (outlineSteps - 1)) * 0.94;
          const point = leafPoint(t, side * 0.985);
          this._particle({
            bud: point,
            open: point,
            size: mix(0.8, 1.75, this.random()),
            alpha: mix(0.3, 0.62, this.random()),
            color: mixRgb(colorEdge, colorLight, t * 0.4 + this.random() * 0.25),
            glow: 0.04,
            soft: 2.75,
            twinkle: 0.06,
            phase: this.random() * TAU,
          });
        }
      }

      for (let i = 0; i < innerSteps; i += 1) {
        const t = 0.08 + this.random() * 0.88;
        const w = (this.random() * 2 - 1) * 0.82;
        const point = leafPoint(t, w);
        this._particle({
          bud: point,
          open: point,
          size: mix(0.65, 1.5, this.random()),
          alpha: mix(0.09, 0.27, this.random()),
          color: mixRgb(colorBase, colorEdge, 0.42 + this.random() * 0.4),
          glow: 0,
          soft: 3.0,
          twinkle: 0.04,
          phase: this.random() * TAU,
        });
      }

      // Bright central vein, ending in a tiny dew bead.
      for (let i = 0; i < veinSteps; i += 1) {
        const t = 0.07 + (i / Math.max(1, veinSteps - 1)) * 0.86;
        const point = leafPoint(t, 0);
        this._particle({
          bud: point,
          open: point,
          size: mix(0.7, 1.45, this.random()),
          alpha: mix(0.2, 0.42, this.random()),
          color: mixRgb(colorLight, [1, 0.87, 0.92], 0.2),
          glow: 0.1,
          soft: 2.5,
          twinkle: 0.12,
          phase: this.random() * TAU,
        });
      }

      const tip = leafPoint(0.965, 0);
      this._particle({
        bud: tip,
        open: tip,
        size: mix(2.2, 3.6, this.random()),
        alpha: 0.62,
        color: hslToRgb(350, 86, 76),
        glow: 0.55,
        soft: 2.1,
        twinkle: 0.2,
        layer: 1,
        phase: this.random() * TAU,
      });
    }
  }

  _buildHeart() {
    const gold = [
      hslToRgb(40, 100, 70),
      hslToRgb(30, 100, 62),
      hslToRgb(46, 92, 80),
    ];
    const blush = hslToRgb(348, 80, 80);

    // A warm, shallow glow that sits behind the crown of stamens.
    for (let i = 0; i < 10; i += 1) {
      const a = this.random() * TAU;
      const r = this.random() * 18;
      this._particle({
        bud: [Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4, 10 + this.random() * 7],
        open: [Math.cos(a) * r, Math.sin(a) * r, 9 + this.random() * 10],
        size: mix(20, 48, this.random()),
        alpha: mix(0.008, 0.024, this.random()),
        color: this.random() > 0.25 ? gold[1] : blush,
        glow: 0.16,
        soft: 1.3,
        reveal: 0.4,
        twinkle: 0.1,
        layer: 1,
        phase: this.random() * TAU,
      });
    }

    // Stamens in two clean rings.  Long amber anthers catch the light while
    // pale filaments stay almost transparent.
    const stamenRings = [
      { count: 30, inner: 14, outer: 52, height: [8, 20], tilt: 0.2 },
      { count: 18, inner: 7, outer: 31, height: [16, 30], tilt: 0.42 },
    ];

    for (const ring of stamenRings) {
      const count = Math.max(10, Math.round(ring.count * this.quality));
      for (let i = 0; i < count; i += 1) {
        const angle =
          (i / count) * TAU + (this.random() - 0.5) * 0.28 + ring.tilt;
        const inner = ring.inner * mix(0.8, 1.2, this.random());
        const outer = ring.outer * mix(0.82, 1.18, this.random());
        const height = mix(ring.height[0], ring.height[1], this.random());
        const lean = mix(-0.18, 0.18, this.random());
        const color = gold[Math.floor(this.random() * gold.length)];

        for (let step = 1; step <= 3; step += 1) {
          const t = step / 3;
          const rr = mix(inner, outer, t);
          const z = 5 + height * t * t + Math.sin(t * Math.PI) * 3;
          const a = angle + lean * t;
          this._particle({
            bud: [rr * Math.cos(a) * 0.45, rr * Math.sin(a) * 0.45, z * 0.7],
            open: [rr * Math.cos(a), rr * Math.sin(a), z],
            arc: [Math.cos(a) * 3, Math.sin(a) * 3, 4],
            delay: 0.28 + this.random() * 0.12,
            duration: 0.4,
            size: mix(0.65, 1.15, this.random()),
            alpha: mix(0.12, 0.28, this.random()),
            color: mixRgb(color, blush, 0.28),
            glow: 0.1,
            soft: 2.5,
            reveal: 0.92,
            twinkle: 0.15,
            layer: 1,
            phase: this.random() * TAU,
          });
        }

        const tipA = angle + lean;
        const tipR = outer;
        const tipZ = 5 + height + 3;
        this._particle({
          bud: [tipR * Math.cos(tipA) * 0.45, tipR * Math.sin(tipA) * 0.45, tipZ * 0.7],
          open: [tipR * Math.cos(tipA), tipR * Math.sin(tipA), tipZ],
          arc: [Math.cos(tipA) * 4, Math.sin(tipA) * 4, 5],
          delay: 0.3 + this.random() * 0.08,
          duration: 0.4,
          size:
            (ring === stamenRings[0]
              ? mix(2.4, 4.1, this.random())
              : mix(3.1, 5.2, this.random())),
          alpha: mix(0.62, 0.94, this.random()),
          color,
          glow: mix(0.6, 0.95, this.random()),
          soft: 2.1,
          reveal: 1,
          twinkle: 0.3,
          layer: 1,
          phase: this.random() * TAU,
        });
      }
    }

    // A compact golden core anchors the eye at the centre of the bloom.
    for (let i = 0; i < 18; i += 1) {
      const a = this.random() * TAU;
      const r = this.random() * 16;
      this._particle({
        bud: [Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4, 13],
        open: [Math.cos(a) * r, Math.sin(a) * r, 18 + this.random() * 8],
        size: mix(3.5, 7.5, this.random()),
        alpha: mix(0.32, 0.68, this.random()),
        color: gold[Math.floor(this.random() * gold.length)],
        glow: mix(0.5, 0.95, this.random()),
        soft: 1.85,
        reveal: 1,
        twinkle: 0.35,
        layer: 1,
        phase: this.random() * TAU,
      });
    }

    // A soft, transparent gold aura keeps the heart visible through the dust.
    for (let i = 0; i < 12; i += 1) {
      const a = this.random() * TAU;
      const r = this.random() * 20;
      this._particle({
        bud: [Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4, 11],
        open: [Math.cos(a) * r, Math.sin(a) * r, 12 + this.random() * 7],
        size: mix(16, 46, this.random()),
        alpha: mix(0.016, 0.04, this.random()),
        color: gold[i % gold.length],
        glow: 0.2,
        soft: 1.3,
        reveal: 1,
        twinkle: 0.15,
        layer: 1,
        phase: this.random() * TAU,
      });
    }
    this._particle({
      bud: [0, 0, 14],
      open: [0, 0, 17],
      size: 11,
      alpha: 0.42,
      color: [1, 0.86, 0.64],
      glow: 0.8,
      soft: 1.8,
      reveal: 1,
      twinkle: 0.2,
      layer: 1,
      phase: 0,
    });

    // Pollen dust suspended over the opening heart.
    const pollen = Math.max(16, Math.round(40 * this.quality));
    for (let i = 0; i < pollen; i += 1) {
      const a = this.random() * TAU;
      const r = 8 + this.random() * 52;
      this._particle({
        bud: [Math.cos(a) * r * 0.38, Math.sin(a) * r * 0.38, 10 + this.random() * 16],
        open: [Math.cos(a) * r, Math.sin(a) * r, 8 + this.random() * 24],
        size: mix(0.7, 2.2, this.random()),
        alpha: mix(0.14, 0.44, this.random()),
        color: this.random() > 0.45 ? gold[2] : blush,
        glow: 0.65,
        soft: 1.9,
        reveal: 1,
        twinkle: 0.4,
        layer: 1,
        phase: this.random() * TAU,
      });
    }
  }

  setPointer(pointer) {
    this.pointer = pointer;
  }

  update(dt, options = {}) {
    const {
      bloom = 0,
      time = 0,
      pointer = this.pointer,
      pointers,
      orbit = this.orbit,
    } = options;
    this.bloom = bloom;
    this.time = time;
    this.pointer = pointer;
    this.orbit = orbit;

    this.resize();

    const { w, h, scale, dpr } = this.view;
    const cx = this.view.cx + clamp(orbit.offsetX || 0, -0.2, 0.2) * w;
    const cy = this.view.cy + clamp(orbit.offsetY || 0, -0.16, 0.16) * h;
    const elevation = clamp(
      orbit.elevation ?? 40 * DEG,
      -38 * DEG,
      84 * DEG
    );
    const yaw =
      (orbit.yaw || 0) +
      Math.sin(time * 0.145) * 0.012 +
      Math.sin(time * 0.31) * 0.003;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosElev = Math.cos(elevation);
    const sinElev = Math.sin(elevation);
    const bob = Math.sin(time * 0.62) * 1.4;
    const breath = 1 + bloom * 0.006 * Math.sin(time * 0.74);
    const sceneScale = scale * mix(1.24, 1, smoothstep(0.02, 0.56, bloom));
    const reveal = smoothstep(0.24, 0.82, bloom);
    const budVisibility = 1 - smoothstep(0.02, 0.44, bloom);
    const pointerList =
      Array.isArray(pointers) && pointers.length
        ? pointers
        : pointer
          ? [pointer]
          : [];
    const activePointers = pointerList.filter((item) => item.active);
    const primaryPointer = activePointers[0] || pointerList[0] || null;
    const radius = this.interactRadius;
    const radius2 = radius * radius;
    const parallaxX = primaryPointer
      ? ((primaryPointer.x || 0) / w - 0.5) * 6
      : 0;
    const parallaxY = primaryPointer
      ? ((primaryPointer.y || 0) / h - 0.5) * 4
      : 0;
    const pressPoints = pointerList
      .filter((item) => (item.press ?? (item.active ? 1 : 0)) > 0.01)
      .map((item) => ({
        x: item.x || 0,
        y: item.y || 0,
        strength: clamp((item.press ?? 1) * (item.strength ?? 1), 0, 1.4),
      }));
    const spring = 112;
    const damping = 15;
    const decay = Math.exp(-dt * 2.7);
    const data = this.buffers.data;
    const count = this.particles.length;

    for (let i = 0; i < count; i += 1) {
      const particle = this.particles[i];
      let t = clamp((bloom - particle.delay) / particle.duration, 0, 1);
      t = t * t * (3 - 2 * t);
      const arc = Math.sin(Math.PI * t);

      let wx = particle.bx + (particle.ox - particle.bx) * t + particle.ax * arc;
      let wy = particle.by + (particle.oy - particle.by) * t + particle.ay * arc;
      let wz = particle.bz + (particle.oz - particle.bz) * t + particle.az * arc;

      // 3D orbit: yaw around the vertical axis, then camera elevation.
      const rx = wx * cosYaw - wy * sinYaw;
      const ry = wx * sinYaw + wy * cosYaw;
      const flatY = ry * sinElev - wz * cosElev;
      const depth = ry * cosElev + wz * sinElev;
      const perspective = clamp(1 + depth / 2400, 0.82, 1.18);
      let baseX = cx + rx * sceneScale * breath * perspective + parallaxX;
      let baseY =
        cy + flatY * sceneScale * breath * perspective + bob + parallaxY;

      // Finger pressure: a spring-loaded dent that follows each fingertip.
      let targetX = 0;
      let targetY = 0;
      let impact = 0;
      let impactSpeed = 0;

      for (const point of activePointers) {
        const dx = baseX - (point.x || 0);
        const dy = baseY - (point.y || 0);
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= radius2) continue;
        const dist = Math.sqrt(dist2) + 0.001;
        const falloff = 1 - dist / radius;
        const pointImpact =
          falloff * falloff * clamp(point.strength ?? 1, 0, 1.4);
        impact = Math.max(impact, pointImpact);
        const pointSpeed = Math.min(
          Math.hypot(point.vx || 0, point.vy || 0),
          1500
        );
        impactSpeed = Math.max(impactSpeed, pointSpeed);
        const drag = Math.min(pointSpeed, 1000) * 0.012 * pointImpact;
        targetX +=
          (dx / dist) * radius * 0.22 * pointImpact +
          (point.vx || 0) * 0.011 * pointImpact -
          (dy / dist) * drag * 0.32;
        targetY +=
          (dy / dist) * radius * 0.22 * pointImpact +
          (point.vy || 0) * 0.011 * pointImpact +
          (dx / dist) * drag * 0.32;
      }

      if (impact > 0) {
        const targetLength = Math.hypot(targetX, targetY);
        if (targetLength > 66) {
          targetX = (targetX / targetLength) * 66;
          targetY = (targetY / targetLength) * 66;
        }
      }

      const idx = i * 2;
      let ox = this.offsets[idx];
      let oy = this.offsets[idx + 1];
      let vx = this.velocities[idx];
      let vy = this.velocities[idx + 1];

      if (
        impact === 0 &&
        ox * ox + oy * oy < 0.0005 &&
        vx * vx + vy * vy < 0.0005
      ) {
        ox = 0;
        oy = 0;
        vx = 0;
        vy = 0;
      } else {
        const ax = (targetX - ox) * spring - vx * damping;
        const ay = (targetY - oy) * spring - vy * damping;
        vx += ax * dt;
        vy += ay * dt;
        ox += vx * dt;
        oy += vy * dt;
        ox = clamp(ox, -74, 74);
        oy = clamp(oy, -74, 74);
      }

      this.offsets[idx] = ox;
      this.offsets[idx + 1] = oy;
      this.velocities[idx] = vx;
      this.velocities[idx + 1] = vy;

      let energy = this.energy[i] * decay;
      if (impact > 0) {
        energy = Math.max(
          energy,
          impact * (0.7 + Math.min(impactSpeed / 950, 1.2))
        );
      }
      this.energy[i] = energy;

      // Sprite appearance.
      const twinkle =
        1 +
        particle.twinkle *
          Math.sin(time * (1.15 + (particle.phase % 0.9)) + particle.phase);
      const revealFactor =
        particle.reveal > 0
          ? 1 - particle.reveal + particle.reveal * reveal
          : 1;
      const ringReveal =
        particle.ring >= 0
          ? smoothstep(
              0.03 + particle.ring * 0.055,
              0.55 + particle.ring * 0.05,
              bloom
            )
          : 1;
      const budFactor = mix(particle.budAlpha, 1, ringReveal);
      let alpha = particle.alpha * twinkle * revealFactor * budFactor;
      if (particle.budOnly) alpha *= budVisibility;
      alpha *= 0.88 + clamp(depth / 1600, -0.18, 0.18);
      alpha *= 1 + energy * 1.15;
      alpha = clamp(alpha * 1.55, 0, 2.2);

      let size =
        particle.size *
        (0.73 + scale * 0.56) *
        perspective *
        (1 + energy * 0.75);
      size = clamp(size, 0.55, 72);

      baseX += ox;
      baseY += oy;

      const offset = i * 9;
      data[offset] = baseX;
      data[offset + 1] = baseY;
      data[offset + 2] = size;
      data[offset + 3] = alpha;
      data[offset + 4] = particle.color[0];
      data[offset + 5] = particle.color[1];
      data[offset + 6] = particle.color[2];
      data[offset + 7] = particle.glow;
      data[offset + 8] = particle.soft;
    }

    this._prepareSepals({
      bloom,
      cosYaw,
      sinYaw,
      cosElev,
      sinElev,
      bob,
      breath,
      parallaxX,
      parallaxY,
      scale: sceneScale,
      cx,
      cy,
    });
    this._prepareBudMesh({
      bloom,
      cosYaw,
      sinYaw,
      cosElev,
      sinElev,
      bob,
      breath,
      parallaxX,
      parallaxY,
      scale: sceneScale,
      cx,
      cy,
      pressPoints,
      pressRadius: this.interactRadius * 0.92,
    });
    this._prepareSurfaces({
      bloom,
      cosYaw,
      sinYaw,
      cosElev,
      sinElev,
      bob,
      breath,
      parallaxX,
      parallaxY,
      scale: sceneScale,
      cx,
      cy,
      pressPoints,
      pressRadius: this.interactRadius * 0.92,
    });
    if (this.ribbonsEnabled) {
      this._prepareRibbons({
        bloom,
        cosYaw,
        sinYaw,
        cosElev,
        sinElev,
        bob,
        breath,
        parallaxX,
        parallaxY,
        scale: sceneScale,
        cx,
        cy,
      });
    }

    this.dpr = dpr;
    this._upload = true;
  }

  _prepareSepals({
    bloom,
    cosYaw,
    sinYaw,
    cosElev,
    sinElev,
    bob,
    breath,
    parallaxX,
    parallaxY,
    scale,
    cx,
    cy,
  }) {
    const mesh = this.sepalMesh;
    const data = this.sepalBuffers.data;
    const openFade = mix(1, 0.5, smoothstep(0.35, 0.96, bloom));
    for (let i = 0; i < mesh.vertexCount; i += 1) {
      const offset = i * 3;
      const x0 = mesh.positions[offset];
      const y0 = mesh.positions[offset + 1];
      const z0 = mesh.positions[offset + 2];
      const rx = x0 * cosYaw - y0 * sinYaw;
      const ry = x0 * sinYaw + y0 * cosYaw;
      const flatY = ry * sinElev - z0 * cosElev;
      const depth = ry * cosElev + z0 * sinElev;
      const perspective = clamp(1 + depth / 2400, 0.82, 1.18);
      const out = i * 6;
      data[out] = cx + rx * scale * breath * perspective + parallaxX;
      data[out + 1] =
        cy + flatY * scale * breath * perspective + bob + parallaxY;
      data[out + 2] = mesh.colors[offset];
      data[out + 3] = mesh.colors[offset + 1];
      data[out + 4] = mesh.colors[offset + 2];
      data[out + 5] = mesh.alphas[i] * openFade;
    }
  }

  _prepareBudMesh({
    bloom,
    cosYaw,
    sinYaw,
    cosElev,
    sinElev,
    bob,
    breath,
    parallaxX,
    parallaxY,
    scale,
    cx,
    cy,
    pressPoints = [],
    pressRadius,
  }) {
    const mesh = this.budMesh;
    const fade = 1 - smoothstep(0.02, 0.44, bloom);
    mesh.fade = fade;
    if (fade <= 0.002) return;

    const data = this.budBuffers.data;
    for (let i = 0; i < mesh.vertexCount; i += 1) {
      const offset = i * 3;
      const x0 = mesh.positions[offset];
      const y0 = mesh.positions[offset + 1];
      const z0 = mesh.positions[offset + 2];
      const rx = x0 * cosYaw - y0 * sinYaw;
      const ry = x0 * sinYaw + y0 * cosYaw;
      const flatY = ry * sinElev - z0 * cosElev;
      const depth = ry * cosElev + z0 * sinElev;
      const perspective = clamp(1 + depth / 2400, 0.82, 1.18);
      let x = cx + rx * scale * breath * perspective + parallaxX;
      let y =
        cy + flatY * scale * breath * perspective + bob + parallaxY;
      let vertexAlpha = mesh.alphas[i] * fade * 0.5;
      let pressLift = 1;

      if (pressPoints.length && pressRadius > 0) {
        for (const point of pressPoints) {
          const dx = x - point.x;
          const dy = y - point.y;
          const distance = Math.hypot(dx, dy);
          if (distance >= pressRadius) continue;
          const falloff = 1 - distance / pressRadius;
          const impact = falloff * falloff * point.strength;
          const inverse = 1 / Math.max(1, distance);
          x += dx * inverse * 20 * impact;
          y += dy * inverse * 20 * impact;
          vertexAlpha *= 1 - 0.2 * impact;
          pressLift = Math.max(pressLift, 1 + 0.7 * impact);
        }
      }

      const out = i * 6;
      data[out] = x;
      data[out + 1] = y;
      data[out + 2] = mesh.colors[offset] * pressLift;
      data[out + 3] = mesh.colors[offset + 1] * pressLift;
      data[out + 4] = mesh.colors[offset + 2] * pressLift;
      data[out + 5] = vertexAlpha;
    }
  }

  _prepareSurfaces({
    bloom,
    cosYaw,
    sinYaw,
    cosElev,
    sinElev,
    bob,
    breath,
    parallaxX,
    parallaxY,
    scale,
    cx,
    cy,
    pressPoints = [],
    pressRadius,
  }) {
    const data = this.surfaceBuffers.data;
    const indices = this.surfaceBuffers.indices;
    let vertexCursor = 0;
    let indexCursor = 0;

    for (const surface of this.surfaces) {
      let t = clamp((bloom - surface.delay) / surface.duration, 0, 1);
      t = t * t * (3 - 2 * t);
      const arc = Math.sin(Math.PI * t);
      const wx = mix(surface.centerBud[0], surface.centerOpen[0], t) + surface.centerArc[0] * arc;
      const wy = mix(surface.centerBud[1], surface.centerOpen[1], t) + surface.centerArc[1] * arc;
      const wz = mix(surface.centerBud[2], surface.centerOpen[2], t) + surface.centerArc[2] * arc;
      const rx = wx * cosYaw - wy * sinYaw;
      const ry = wx * sinYaw + wy * cosYaw;
      surface.sortDepth = ry * cosElev + wz * sinElev;
      surface.sortX = rx;
      surface.eased = t;
      surface.arc = arc;
    }

    this.surfaces.sort((a, b) => a.sortDepth - b.sortDepth);

    for (const surface of this.surfaces) {
      const { petal, ring, vertices, cols } = surface;
      const ringReveal = smoothstep(
        0.03 + ring.ringIndex * 0.055,
        0.55 + ring.ringIndex * 0.05,
        bloom
      );
      const alphaFactor = mix(surface.budAlpha, 1, ringReveal);
      const t = surface.eased;
      const arc = surface.arc;
      const baseVertex = vertexCursor;

      for (let i = 0; i < surface.vertexCount; i += 1) {
        const offset = i * 3;
        let wx = vertices.bud[offset] + (vertices.open[offset] - vertices.bud[offset]) * t;
        let wy =
          vertices.bud[offset + 1] +
          (vertices.open[offset + 1] - vertices.bud[offset + 1]) * t;
        let wz =
          vertices.bud[offset + 2] +
          (vertices.open[offset + 2] - vertices.bud[offset + 2]) * t;
        wx += petal.leanX * 0.15 * (1 - t);
        wy += petal.leanY * 0.15 * (1 - t);
        wz += arc * 4 * (ring.ringIndex === 0 ? 0.65 : 1);

        const rx = wx * cosYaw - wy * sinYaw;
        const ry = wx * sinYaw + wy * cosYaw;
        const flatY = ry * sinElev - wz * cosElev;
        const depth = ry * cosElev + wz * sinElev;
        const perspective = clamp(1 + depth / 2400, 0.82, 1.18);
        let x = cx + rx * scale * breath * perspective + parallaxX;
        let y =
          cy + flatY * scale * breath * perspective + bob + parallaxY;
        let vertexAlpha = vertices.alpha[i] * alphaFactor;
        let pressLift = 1;

        // Each fingertip dents and warms the silk, not just the dust above it.
        if (pressPoints.length && pressRadius > 0) {
          for (const point of pressPoints) {
            const dx = x - point.x;
            const dy = y - point.y;
            const distance = Math.hypot(dx, dy);
            if (distance >= pressRadius) continue;
            const falloff = 1 - distance / pressRadius;
            const impact = falloff * falloff * point.strength;
            const push = 26 * impact;
            const inverse = 1 / Math.max(1, distance);
            x += dx * inverse * push;
            y += dy * inverse * push;
            vertexAlpha *= 1 - 0.17 * impact;
            pressLift = Math.max(pressLift, 1 + 0.8 * impact);
          }
        }

        const light = mix(
          vertices.light[i * 2],
          vertices.light[i * 2 + 1],
          t
        );
        const out = vertexCursor * 6;
        data[out] = x;
        data[out + 1] = y;
        data[out + 2] = vertices.color[offset] * light * pressLift;
        data[out + 3] = vertices.color[offset + 1] * light * pressLift;
        data[out + 4] = vertices.color[offset + 2] * light * pressLift;
        data[out + 5] = vertexAlpha;

        vertexCursor += 1;
      }

      for (let i = 0; i < surface.indices.length; i += 1) {
        indices[indexCursor] = baseVertex + surface.indices[i];
        indexCursor += 1;
      }
    }

    this.surfaceBuffers.vertexCount = vertexCursor;
    this.surfaceBuffers.indexCount = indexCursor;
  }

  _prepareRibbons({
    bloom,
    cosYaw,
    sinYaw,
    cosElev,
    sinElev,
    bob,
    breath,
    parallaxX,
    parallaxY,
    scale,
    cx,
    cy,
  }) {
    const data = this.ribbonBuffers.data;
    const reveal = smoothstep(0.045, 0.26, bloom);
    const budFade = 1 - smoothstep(0.03, 0.24, bloom);

    const stripWeights = [0.05, 0.38, 1, 0.38, 0.05];
    const stripOffsets = [-1, -0.5, 0, 0.5, 1];
    const halfWidth = 1.55 * (0.74 + scale * 0.36);
    let cursor = 0;
    const points = [];

    for (const ribbon of this.ribbons) {
      let t = clamp((bloom - ribbon.delay) / 0.56, 0, 1);
      t = t * t * (3 - 2 * t);
      const samples = ribbon.samples;
      points.length = 0;

      for (const sample of samples) {
        const wx = mix(sample.bud[0], sample.open[0], t);
        const wy = mix(sample.bud[1], sample.open[1], t);
        const wz = mix(sample.bud[2], sample.open[2], t);
        const rx = wx * cosYaw - wy * sinYaw;
        const ry = wx * sinYaw + wy * cosYaw;
        const flatY = ry * sinElev - wz * cosElev;
        const depth = ry * cosElev + wz * sinElev;
        const perspective = clamp(1 + depth / 2400, 0.82, 1.18);
        points.push({
          x: cx + rx * scale * breath * perspective + parallaxX,
          y: cy + flatY * scale * breath * perspective + bob + parallaxY,
        });
      }

      const ringWeight = [0.82, 0.46, 0.13][ribbon.ring.ringIndex] ?? 1;
      const front = 0.5 + 0.5 * Math.sin(ribbon.petal.angle);
      const budSeam = 0;
      const activation =
        reveal * (0.55 + 0.45 * t) * ringWeight * 0.05 + budSeam;
      for (let i = 0; i < samples.length; i += 1) {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        const sample = samples[i];
        const point = points[i];
        const width = halfWidth * (0.72 + 0.28 * smoothstep(0.1, 0.8, sample.v));

        for (let strip = 0; strip < 5; strip += 1) {
          const offset = stripOffsets[strip] * width;
          const alpha = sample.alpha * stripWeights[strip] * activation;
          data[cursor] = point.x + nx * offset;
          data[cursor + 1] = point.y + ny * offset;
          data[cursor + 2] = sample.color[0];
          data[cursor + 3] = sample.color[1];
          data[cursor + 4] = sample.color[2];
          data[cursor + 5] = alpha;
          cursor += 6;
        }
      }
    }

    this.ribbonBuffers.vertexCount = cursor / 6;
  }

  render() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this._upload) return;

    if (!this.debug.hideSepals) {
      gl.useProgram(this.surfaceProgram);
      gl.uniform2f(this.surfaceUniforms.resolution, this.view.w, this.view.h);
      gl.bindVertexArray(this.sepalBuffers.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sepalBuffers.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sepalBuffers.data);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(
        gl.TRIANGLES,
        this.sepalMesh.indexCount,
        gl.UNSIGNED_SHORT,
        0
      );
    }

    if (this.budMesh.fade > 0.002 && !this.debug.hideBud) {
      gl.useProgram(this.surfaceProgram);
      gl.uniform2f(this.surfaceUniforms.resolution, this.view.w, this.view.h);
      gl.bindVertexArray(this.budBuffers.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.budBuffers.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.budBuffers.data);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(
        gl.TRIANGLES,
        this.budMesh.indexCount,
        gl.UNSIGNED_SHORT,
        0
      );
    }

    if (this.surfaceBuffers?.indexCount > 0) {
      gl.useProgram(this.surfaceProgram);
      gl.uniform2f(this.surfaceUniforms.resolution, this.view.w, this.view.h);
      gl.bindVertexArray(this.surfaceBuffers.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.surfaceBuffers.vbo);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.surfaceBuffers.data.subarray(0, this.surfaceBuffers.vertexCount * 6)
      );
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.surfaceBuffers.ebo);
      gl.bufferSubData(
        gl.ELEMENT_ARRAY_BUFFER,
        0,
        this.surfaceBuffers.indices.subarray(0, this.surfaceBuffers.indexCount)
      );
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(
        gl.TRIANGLES,
        this.surfaceBuffers.indexCount,
        gl.UNSIGNED_SHORT,
        0
      );
    }

    if (
      this.ribbonsEnabled &&
      this.ribbonBuffers.vertexCount > 0 &&
      !this.debug.hideRibbons
    ) {
      gl.useProgram(this.surfaceProgram);
      gl.uniform2f(this.surfaceUniforms.resolution, this.view.w, this.view.h);
      gl.bindVertexArray(this.ribbonBuffers.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonBuffers.vbo);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.ribbonBuffers.data.subarray(
          0,
          this.ribbonBuffers.vertexCount * 6
        )
      );
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawElements(
        gl.TRIANGLES,
        this.ribbonBuffers.indexCount,
        gl.UNSIGNED_SHORT,
        0
      );
    }

    if (!this.debug.hideParticles) {
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.resolution, this.view.w, this.view.h);
      gl.uniform1f(this.uniforms.dpr, this.view.dpr);
      gl.uniform1f(this.uniforms.glowScale, 1);
      gl.uniform1f(this.uniforms.alphaScale, 1);
      gl.bindVertexArray(this.buffers.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.buffers.data);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this.bodyCount);
      gl.drawArrays(gl.POINTS, this.bodyCount, this.glowCount);
      gl.uniform1f(this.uniforms.alphaScale, 1);
      gl.uniform1f(this.uniforms.glowScale, 1);
      gl.bindVertexArray(null);
    }
  }

  getParticleCount() {
    return this.particles.length;
  }
}

