import './style.css';
import { DustField } from './dust.js';
import { FlowerField } from './flower.js';
import { HandAura } from './aura.js';
import { HandTracker } from './hand.js';

const $ = (selector) => document.querySelector(selector);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const mix = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const DEG = Math.PI / 180;
const BASE_ELEVATION = 40 * DEG;
const ORBIT_TOP_ELEVATION = 78 * DEG;
const ORBIT_BOTTOM_ELEVATION = -28 * DEG;
const RELATIVE_ORBIT_SPAN = 0.76;
const ORBIT_YAW_GAIN = (Math.PI * 2) / RELATIVE_ORBIT_SPAN;
const ORBIT_ELEVATION_GAIN =
  (ORBIT_TOP_ELEVATION - ORBIT_BOTTOM_ELEVATION) / RELATIVE_ORBIT_SPAN;

function readOrbitSensitivity() {
  try {
    const value = Number(localStorage.getItem('petal-bloom.orbit-sensitivity'));
    if (Number.isFinite(value) && value >= 0.4 && value <= 1.6) return value;
  } catch {
    // localStorage can be unavailable in private windows.
  }
  return 1;
}

function writeOrbitSensitivity(value) {
  try {
    localStorage.setItem('petal-bloom.orbit-sensitivity', String(value));
  } catch {
    // Non-critical preference.
  }
}

const params = new URLSearchParams(window.location.search);
const queryBloom = params.has('bloom') ? clamp(Number(params.get('bloom')) || 0, 0, 1) : 0;
const wantsDemo = params.get('demo') === '1';
const debugApi = params.get('debug') === '1' || params.get('manual') === '1';

const elements = {
  intro: $('#intro'),
  startBtn: $('#start-btn'),
  demoBtn: $('#demo-btn'),
  introStatus: $('#intro-status'),
  gestureChip: $('#gesture-chip'),
  gestureLabel: $('#gesture-label'),
  gestureEn: $('#gesture-en'),
  fingerPips: [...document.querySelectorAll('#finger-pips i')],
  secondaryChip: $('#secondary-chip'),
  secondaryLabel: $('#secondary-label'),
  resetBtn: $('#reset-btn'),
  motionBtn: $('#motion-btn'),
  motionPanel: $('#motion-panel'),
  motionRange: $('#motion-range'),
  motionValue: $('#motion-value'),
  motionClose: $('#motion-close'),
  motionDefault: $('#motion-default'),
  cameraPanel: $('#camera-panel'),
  liveDot: $('#live-dot'),
  liveLabel: $('#live-label'),
  camState: $('#cam-state'),
  statusEyebrow: $('#status-eyebrow'),
  statusPercent: $('#status-percent'),
  statusText: $('#status-text'),
  progressFill: $('#progress-fill'),
  progressSpark: $('#progress-spark'),
  toast: $('#toast'),
  bloomHalo: $('#bloom-halo'),
};

const state = {
  started: false,
  demoMode: false,
  cameraActive: false,
  bloom: queryBloom,
  gesture: 'none',
  handPresent: false,
  openness: 0,
  fingers: [false, false, false, false, false],
  resetting: false,
  closing: false,
  closeElapsed: 0,
  closedAt: -1,
  orbitSensitivity: readOrbitSensitivity(),
  orbitYaw: 0,
  orbitElevation: BASE_ELEVATION,
  orbitTargetYaw: 0,
  orbitTargetElevation: BASE_ELEVATION,
  orbitYawVelocity: 0,
  orbitElevationVelocity: 0,
  lastOrbitDetectionId: 0,
  orbitActiveHandId: null,
  orbitHandInputs: new Map(),
  handCount: 0,
  bothHands: false,
  secondaryGesture: 'none',
  anyHandOpen: false,
  openedOnce: queryBloom >= 0.999,
  demoTime: 0,
  demoHoldUntil: 0,
  demoGesture: 'fist',
  demoPointer: { x: 0, y: 0 },
  source: 'none',
  time: 0,
  startedAt: 0,
  lastUiAt: 0,
  lastPreviewAt: 0,
  lastUiSignature: '',
  lastStatusText: '',
  lastGestureLabel: '',
  fps: 0,
  frameCount: 0,
  fpsSince: performance.now(),
  detectMs: 0,
  updateMs: 0,
  renderMs: 0,
  openCooldownUntil: 0,
};

const mouse = {
  active: false,
  x: 0,
  y: 0,
  lastAt: 0,
};

const pointerStates = new Map();

function ensurePointerState(id, x, y, time) {
  let pointerState = pointerStates.get(id);
  if (!pointerState) {
    pointerState = {
      id,
      x,
      y,
      vx: 0,
      vy: 0,
      active: false,
      strength: 1,
      press: 0,
      gesture: 'none',
      role: 'primary',
      lastActiveAt: 0,
      lastSeenAt: time,
      initialized: false,
    };
    pointerStates.set(id, pointerState);
  }
  pointerState.lastSeenAt = time;
  return pointerState;
}

const debug = {
  frozen: false,
  gesture: null,
  bloom: null,
  pointer: null,
  pointerActive: false,
  orbit: null,
};

let flower;
let dust;
let aura;
let hand;
let starting = false;
let toastTimer = 0;
let rafId = 0;
let lastFrameAt = performance.now();
let introEnded = false;
let motionPanelOpen = false;

function setOrbitSensitivity(value, persist = true) {
  const sensitivity = clamp(value, 0.4, 1.6);
  state.orbitSensitivity = sensitivity;
  const percent = Math.round(sensitivity * 100);
  if (elements.motionRange) {
    elements.motionRange.value = String(percent);
    const fill = ((sensitivity - 0.4) / 1.2) * 100;
    elements.motionRange.style.setProperty('--fill', `${fill.toFixed(2)}%`);
  }
  if (elements.motionValue) {
    elements.motionValue.textContent = `${percent}%`;
  }
  if (persist) writeOrbitSensitivity(sensitivity);
}

function setMotionPanel(open) {
  if (!elements.motionPanel || !elements.motionBtn) return;
  motionPanelOpen = open;
  elements.motionPanel.classList.toggle('is-open', open);
  elements.motionPanel.setAttribute('aria-hidden', String(!open));
  elements.motionBtn.setAttribute('aria-expanded', String(open));
}

function showToast(message, duration = 2400) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('is-show');
  }, duration);
}

function setIntroStatus(text, isError = false) {
  if (!elements.introStatus) return;
  elements.introStatus.textContent = text;
  elements.introStatus.classList.toggle('is-error', isError);
}

function enterLive(mode) {
  if (state.started) return;
  state.started = true;
  state.demoMode = mode === 'demo';
  state.cameraActive = mode === 'camera';
  state.startedAt = state.time;
  state.demoTime = 0;
  state.demoPointer = {
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.49,
  };

  document.body.classList.add('is-live');
  if (mode === 'demo') {
    elements.cameraPanel.dataset.mode = 'demo';
    elements.liveLabel.textContent = 'GESTURE · DEMO';
    elements.camState.textContent = '模拟手势 · 环绕花瓣';
    elements.liveDot.classList.remove('is-off');
    showToast('演示模式 · 把手势想成一阵春风', 3200);
  } else {
    elements.cameraPanel.dataset.mode = 'camera';
    elements.liveLabel.textContent = 'CAMERA · LIVE';
    elements.camState.textContent = '正在寻找手掌';
    elements.liveDot.classList.remove('is-off');
    if (hand?.cameraLabel) {
      elements.cameraPanel.title = `当前摄像头：${hand.cameraLabel}`;
    }
    showToast('镜头已连接 · 将手掌放入画面', 3000);
  }

  elements.intro.classList.add('is-leaving');
  elements.intro.setAttribute('aria-hidden', 'true');
  introEnded = true;
  window.setTimeout(() => {
    if (elements.intro) elements.intro.style.display = 'none';
  }, 1250);

  updateUi(performance.now(), true);
}

async function startExperience() {
  if (starting || state.started) return;
  starting = true;
  elements.startBtn.classList.add('is-busy');
  elements.startBtn.querySelector('.start-button__label').textContent = '开启花灵';
  setIntroStatus('正在与镜头建立连接');

  try {
    await hand.start();
    enterLive('camera');
  } catch (error) {
    hand.stop();
    const message =
      hand.error ||
      error?.message ||
      '镜头或手势模型未能启动，请重试或使用演示模式。';
    setIntroStatus(message, true);
    showIntroErrorCue();
    elements.startBtn.querySelector('.start-button__label').textContent = '重新开启';
  } finally {
    starting = false;
    elements.startBtn.classList.remove('is-busy');
  }
}

function showIntroErrorCue() {
  elements.demoBtn.style.color = 'rgba(255, 235, 242, 0.78)';
  elements.demoBtn.style.borderColor = 'rgba(255, 194, 215, 0.48)';
}

function startDemo() {
  if (state.started) return;
  enterLive('demo');
}

function resetBloom() {
  if (!state.started || state.resetting) return;
  state.resetting = true;
  state.closing = false;
  state.closeElapsed = 0;
  state.openedOnce = false;
  state.openCooldownUntil = state.time + 1.1;
  document.body.classList.remove('is-full');
  elements.resetBtn.classList.add('is-busy');
  if (state.demoMode) {
    state.demoHoldUntil = state.time + 2.6;
    state.demoGesture = 'fist';
  }
  showToast('花灵重新含苞 · 张开手掌可再次唤醒', 2400);
}

function mapCameraPointer(normalized) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const mx = w * 0.045;
  const my = h * 0.07;
  return {
    x: mx + (1 - normalized.x) * (w - mx * 2),
    y: my + normalized.y * (h - my * 2),
  };
}

function updateDemo(dt) {
  state.demoTime += dt;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const t = state.demoTime;

  if (state.time < state.demoHoldUntil) {
    state.demoGesture = 'fist';
  } else if (t < 1.15) {
    state.demoGesture = 'fist';
  } else if (t < 5.55) {
    state.demoGesture = 'open';
  } else {
    state.demoGesture = 'fist';
  }

  const orbitX =
    w * 0.5 +
    Math.sin(t * 0.42) * w * 0.22 +
    Math.sin(t * 0.19 + 1.1) * w * 0.055;
  const orbitY =
    h * 0.47 +
    Math.sin(t * 0.67 + 1.7) * h * 0.145 +
    Math.cos(t * 0.33) * h * 0.035;
  state.demoPointer.x = orbitX;
  state.demoPointer.y = orbitY;

  return {
    gesture: state.demoGesture,
    targetX: orbitX,
    targetY: orbitY,
    active: true,
    present: true,
    fingers:
      state.demoGesture === 'open'
        ? [true, true, true, true, true]
        : [false, false, false, false, false],
    strength: state.demoGesture === 'open' ? 1.04 : 0.86,
  };
}

function applyRelativeOrbit(handSnapshot) {
  const now = handSnapshot.detectionAt || performance.now();
  const present = new Set();

  for (const hand of handSnapshot.hands || []) {
    if (!hand.palmRaw) continue;
    present.add(hand.id);
    const isOpen = hand.gesture === 'open';
    const x = 1 - hand.palmRaw.x;
    const y = hand.palmRaw.y;
    let input = state.orbitHandInputs.get(hand.id);

    if (!isOpen) {
      if (input) {
        input.open = false;
        input.stepX = 0;
        input.stepY = 0;
        input.speed = 0;
        input.lastSeenAt = now;
      }
      continue;
    }

    if (!input) {
      input = {
        id: hand.id,
        rawX: x,
        rawY: y,
        filteredX: x,
        filteredY: y,
        appliedX: x,
        appliedY: y,
        lastTime: now,
        lastDetectionId: handSnapshot.detectionId,
        stepX: 0,
        stepY: 0,
        speed: 0,
        open: true,
        lastSeenAt: now,
      };
      state.orbitHandInputs.set(hand.id, input);
      continue;
    }

    input.lastSeenAt = now;

    if (!input.open) {
      Object.assign(input, {
        rawX: x,
        rawY: y,
        filteredX: x,
        filteredY: y,
        appliedX: x,
        appliedY: y,
        lastTime: now,
        lastDetectionId: handSnapshot.detectionId,
        stepX: 0,
        stepY: 0,
        speed: 0,
        open: true,
      });
      continue;
    }

    const deltaTime = (now - input.lastTime) / 1000;
    const detectionGap =
      handSnapshot.detectionId - input.lastDetectionId;
    if (deltaTime <= 0.006 || deltaTime > 0.28 || detectionGap > 2) {
      Object.assign(input, {
        rawX: x,
        rawY: y,
        filteredX: x,
        filteredY: y,
        appliedX: x,
        appliedY: y,
        lastTime: now,
        lastDetectionId: handSnapshot.detectionId,
        stepX: 0,
        stepY: 0,
        speed: 0,
      });
      continue;
    }

    const rawDx = x - input.rawX;
    const rawDy = y - input.rawY;
    const rawSpeed = Math.hypot(rawDx, rawDy) / deltaTime;
    // Low-pass the palm, but open the filter quickly while the hand moves.
    const alpha =
      1 - Math.exp(-deltaTime * (12 + Math.min(rawSpeed * 24, 20)));
    input.filteredX += (x - input.filteredX) * alpha;
    input.filteredY += (y - input.filteredY) * alpha;

    let stepX = input.filteredX - input.appliedX;
    let stepY = input.filteredY - input.appliedY;
    input.appliedX = input.filteredX;
    input.appliedY = input.filteredY;
    input.rawX = x;
    input.rawY = y;
    input.lastTime = now;
    input.lastDetectionId = handSnapshot.detectionId;

    if (Math.hypot(stepX, stepY) < 0.0012) {
      stepX = 0;
      stepY = 0;
      input.speed = 0;
    } else {
      stepX = clamp(stepX, -0.075, 0.075);
      stepY = clamp(stepY, -0.075, 0.075);
      input.speed = Math.hypot(stepX, stepY) / deltaTime;
    }
    input.stepX = stepX;
    input.stepY = stepY;
    input.open = true;
  }

  for (const [id, input] of state.orbitHandInputs) {
    if (!present.has(id)) {
      input.open = false;
      input.stepX = 0;
      input.stepY = 0;
      input.speed = 0;
    }
    if (now - input.lastSeenAt > 2500) {
      state.orbitHandInputs.delete(id);
    }
  }

  let best = null;
  for (const input of state.orbitHandInputs.values()) {
    if (!input.open) continue;
    if (!best || input.speed > best.speed) best = input;
  }

  let active = state.orbitActiveHandId
    ? state.orbitHandInputs.get(state.orbitActiveHandId)
    : null;
  if (!active || !active.open) {
    if (best && best.speed > 0.05) {
      state.orbitActiveHandId = best.id;
    }
  } else if (best && best.id !== active.id) {
    const activeMoving = active.speed > 0.05;
    const otherClearlyFaster =
      best.speed > Math.max(0.12, active.speed * 1.8);
    if ((!activeMoving && best.speed > 0.05) || otherClearlyFaster) {
      state.orbitActiveHandId = best.id;
    }
  }

  active = state.orbitActiveHandId
    ? state.orbitHandInputs.get(state.orbitActiveHandId)
    : null;
  if (!active || !active.open || active.speed <= 0.04) return;

  const sensitivity = state.orbitSensitivity;
  state.orbitTargetYaw +=
    active.stepX * ORBIT_YAW_GAIN * sensitivity;
  state.orbitTargetElevation = clamp(
    state.orbitTargetElevation +
      active.stepY * ORBIT_ELEVATION_GAIN * sensitivity,
    ORBIT_BOTTOM_ELEVATION,
    ORBIT_TOP_ELEVATION
  );
}

function updateOrbit(dt, handSnapshot) {
  if (debug.orbit) {
    state.orbitTargetYaw = debug.orbit.yaw ?? state.orbitTargetYaw;
    state.orbitTargetElevation = clamp(
      debug.orbit.elevation ?? state.orbitTargetElevation,
      ORBIT_BOTTOM_ELEVATION,
      ORBIT_TOP_ELEVATION
    );
  } else if (state.demoMode) {
    const demoX = state.demoPointer.x / Math.max(1, window.innerWidth);
    const demoY = state.demoPointer.y / Math.max(1, window.innerHeight);
    const horizontal = clamp((demoX - 0.5) * 2, -1, 1);
    const vertical = clamp((demoY - 0.5) * 2, -1, 1);
    state.orbitTargetYaw = horizontal * 2.5;
    state.orbitTargetElevation =
      vertical >= 0
        ? mix(BASE_ELEVATION, ORBIT_TOP_ELEVATION, Math.abs(vertical))
        : mix(BASE_ELEVATION, ORBIT_BOTTOM_ELEVATION, Math.abs(vertical));
  } else if (
    handSnapshot?.detectionId &&
    handSnapshot.detectionId !== state.lastOrbitDetectionId
  ) {
    state.lastOrbitDetectionId = handSnapshot.detectionId;
    applyRelativeOrbit(handSnapshot);
  }

  // Critically-ish damped spring: the 20–30fps detection stream sets the
  // target, while this runs every display frame and removes the stepping.
  const step = Math.min(dt, 0.04);
  const stiffness = 160;
  const damping = 23;
  const yawAcceleration =
    (state.orbitTargetYaw - state.orbitYaw) * stiffness -
    state.orbitYawVelocity * damping;
  state.orbitYawVelocity += yawAcceleration * step;
  state.orbitYaw += state.orbitYawVelocity * step;

  const elevationAcceleration =
    (state.orbitTargetElevation - state.orbitElevation) * stiffness -
    state.orbitElevationVelocity * damping;
  state.orbitElevationVelocity += elevationAcceleration * step;
  state.orbitElevation += state.orbitElevationVelocity * step;

  if (state.orbitElevation <= ORBIT_BOTTOM_ELEVATION) {
    state.orbitElevation = ORBIT_BOTTOM_ELEVATION;
    state.orbitElevationVelocity = Math.max(
      0,
      state.orbitElevationVelocity
    );
  } else if (state.orbitElevation >= ORBIT_TOP_ELEVATION) {
    state.orbitElevation = ORBIT_TOP_ELEVATION;
    state.orbitElevationVelocity = Math.min(
      0,
      state.orbitElevationVelocity
    );
  }

  // Keep the angle bounded without disturbing the relative offset.
  if (Math.abs(state.orbitYaw) > Math.PI * 6) {
    const turns = Math.round(state.orbitYaw / (Math.PI * 2));
    state.orbitYaw -= turns * Math.PI * 2;
    state.orbitTargetYaw -= turns * Math.PI * 2;
  }
}

function statusTextFor(bloom) {
  if (state.resetting) return '花灵重新敛起花瓣…';
  if (state.closing) {
    return state.bothHands
      ? '双掌收拢 · 花灵重新含苞'
      : '掌心收拢 · 花灵重新含苞';
  }
  if (bloom <= 0.01 && state.closedAt >= 0 && state.gesture !== 'open') {
    return '花已重新含苞 · 张开手掌再次唤醒';
  }
  if (bloom >= 0.999) {
    return state.bothHands
      ? '花开正好 · 双拳会让它重新含苞'
      : '花开正好 · 握拳会让它重新含苞';
  }
  if (state.gesture === 'open' && bloom < 0.01) return '第一片花瓣正在醒来';
  if (state.gesture === 'open') return '花瓣舒展中 · 移动手掌环绕';
  if (state.gesture === 'fist' && bloom > 0.008) return '花苞停在你留住的这一刻';
  if (bloom > 0.008) return '静待下一次舒展';
  if ((state.cameraActive && !state.handPresent) || state.demoMode) {
    return state.demoMode ? '手掌轻展，花瓣便会苏醒' : '将手掌放入画面 · 五指轻展';
  }
  return '指尖轻展，花苞便会苏醒';
}

function updateUi(now, force = false) {
  if (!state.started) return;

  const bloom = state.bloom;
  const signature = [
    state.gesture,
    state.handPresent,
    state.handCount,
    state.bothHands ? 1 : 0,
    state.secondaryGesture,
    state.fingers.join(','),
    Math.round(bloom * 100),
    state.resetting ? 1 : 0,
    state.closing ? 1 : 0,
    state.demoMode ? 1 : 0,
  ].join('|');

  if (!force && now - state.lastUiAt < 66) return;
  state.lastUiAt = now;

  if (force || signature !== state.lastUiSignature) {
    state.lastUiSignature = signature;

    const chip = elements.gestureChip;
    chip.classList.remove('is-open', 'is-fist', 'is-none', 'is-reading');
    if (state.gesture === 'open') {
      chip.classList.add('is-open');
    } else if (state.gesture === 'fist') {
      chip.classList.add('is-fist');
    } else if (state.handPresent) {
      chip.classList.add('is-reading');
    } else {
      chip.classList.add('is-none');
    }

    const dual = state.bothHands;
    let label = dual ? '主手 · 寻找' : '寻找手掌';
    let en = 'SEARCHING';
    if (state.gesture === 'open') {
      label = dual ? '主手 · 五指张开' : '五指张开';
      en = 'BLOSSOM';
    } else if (state.gesture === 'fist') {
      label = dual ? '主手 · 保持拳头' : '保持拳头';
      en = 'HOLD';
    } else if (state.handPresent) {
      label = dual ? '主手 · 辨认中' : '手势辨认中';
      en = 'READING';
    }
    if (state.demoMode) en = state.gesture === 'none' ? 'DEMO READY' : `DEMO · ${en}`;
    if (dual) en = `DUAL · ${en}`;
    if (elements.secondaryChip) {
      elements.secondaryChip.classList.toggle('is-on', dual);
      if (dual) {
        elements.secondaryLabel.textContent =
          state.secondaryGesture === 'open'
            ? '副手 · 五指张开'
            : state.secondaryGesture === 'fist'
              ? '副手 · 待机'
              : '副手 · 识别中';
      }
    }
    if (label !== state.lastGestureLabel) {
      elements.gestureLabel.textContent = label;
      elements.gestureEn.textContent = en;
      state.lastGestureLabel = label;
    }

    for (let i = 0; i < 5; i += 1) {
      elements.fingerPips[i]?.classList.toggle('is-on', !!state.fingers[i]);
    }

    const text = statusTextFor(bloom);
    if (text !== state.lastStatusText) {
      elements.statusText.textContent = text;
      state.lastStatusText = text;
    }

    let cameraText = '正在寻找手掌';
    if (!state.cameraActive) {
      cameraText = '模拟手势 · 环绕花瓣';
    } else if (state.closing) {
      cameraText = state.bothHands
        ? '双掌收拢 · 重新含苞'
        : '掌心收拢 · 重新含苞';
    } else if (state.bothHands) {
      if (
        state.gesture === 'fist' &&
        state.secondaryGesture === 'fist' &&
        state.bloom >= 0.999
      ) {
        cameraText = '双拳合拢 · 重新含苞';
      } else if (
        state.gesture === 'fist' &&
        state.secondaryGesture === 'fist'
      ) {
        cameraText = '双手停留 · 花苞静止';
      } else {
        cameraText = '双手移动 · 自由环绕';
      }
    } else if (state.gesture === 'open') {
      cameraText =
        state.bloom >= 0.999 ? '五指张开 · 环绕中' : '五指张开 · 正在盛放';
    } else if (state.gesture === 'fist') {
      if (state.bloom >= 0.999) cameraText = '握拳 · 重新含苞';
      else if (state.bloom <= 0.01 && state.closedAt >= 0) {
        cameraText = '花已重新含苞';
      } else {
        cameraText = '握拳 · 花已停留';
      }
    } else if (state.handPresent) {
      cameraText = '手势辨认中';
    }
    if (elements.camState.textContent !== cameraText) {
      elements.camState.textContent = cameraText;
    }
  }

  const percent = Math.round(bloom * 100);
  const fill = `${(bloom * 100).toFixed(2)}%`;
  elements.progressFill.style.width = fill;
  elements.progressSpark.style.left = fill;
  elements.progressSpark.classList.toggle('is-on', bloom > 0.01);
  elements.statusPercent.textContent = `${percent}%`;
  const returning = state.resetting || state.closing;
  elements.statusEyebrow.textContent = returning
    ? `RETURNING · ${String(percent).padStart(3, '0')}`
    : bloom >= 0.999
      ? 'IN FULL BLOOM · 100'
      : `BLOSSOM · ${String(percent).padStart(3, '0')}`;

  if (elements.bloomHalo) {
    const h = 0.3 + bloom * 0.7;
    elements.bloomHalo.style.opacity = h.toFixed(3);
    elements.bloomHalo.style.transform = `translate(-50%, -50%) scale(${(0.66 + bloom * 0.4).toFixed(3)})`;
  }

  if (bloom >= 0.999 && !state.openedOnce) {
    state.openedOnce = true;
    document.body.classList.add('is-full');
    showToast(
      state.bothHands
        ? '花开正好 · 双手移动环绕，双拳重新含苞'
        : '花开正好 · 移动手掌环绕，握拳重新含苞',
      3000
    );
  }
  if (state.resetting && bloom <= 0.0005) {
    state.resetting = false;
    elements.resetBtn.classList.remove('is-busy');
  }
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.033, Math.max(0.001, (now - lastFrameAt) / 1000));
  lastFrameAt = now;
  state.time += dt;

  state.frameCount += 1;
  if (now - state.fpsSince > 1000) {
    state.fps = Math.round((state.frameCount * 1000) / (now - state.fpsSince));
    state.frameCount = 0;
    state.fpsSince = now;
  }

  let handSnapshot = null;
  if (hand && hand.ready) {
    const detectStart = performance.now();
    hand.detect(now);
    state.detectMs = mix(state.detectMs, performance.now() - detectStart, 0.2);
    handSnapshot = hand.getSnapshot();

    // Adjust tracking cadence to the machine.  The bloom itself is always
    // rendered at display rate; only the landmark stream is throttled.
    const cost = handSnapshot.lastCost || 0;
    if (hand.detectorMode === 'worker') {
      // Inference runs off the main thread. One frame is always in flight, so
      // a short interval lets the worker process the next camera frame as soon
      // as it is free, without queueing stale frames.
      hand.detectInterval = state.time > 4 && state.fps < 50 ? 55 : 33;
    } else {
      if (cost > 30) {
        hand.detectInterval = 90;
      } else if (cost > 20) {
        hand.detectInterval = 60;
      } else if (cost > 12) {
        hand.detectInterval = 45;
      } else if (cost > 0) {
        hand.detectInterval = 33;
      }

      // Protect animation only when the display rate is genuinely struggling.
      if (state.time > 4 && state.fps > 0) {
        const fpsFloor =
          state.fps < 42 ? 60 : state.fps < 48 ? 45 : 33;
        hand.detectInterval = Math.max(hand.detectInterval, fpsFloor);
      }
    }

    if (now - state.lastPreviewAt > 33) {
      hand.drawPreview();
      state.lastPreviewAt = now;
    }
  }

  const presentHands = handSnapshot?.hands || [];
  const primaryHand = handSnapshot?.primary || null;
  const secondaryHand = handSnapshot?.secondary || null;
  const handsApart = !!(
    primaryHand?.palmRaw &&
    secondaryHand?.palmRaw &&
    Math.hypot(
      (primaryHand.palmRaw.x - secondaryHand.palmRaw.x) * 1.08,
      primaryHand.palmRaw.y - secondaryHand.palmRaw.y
    ) > 0.1
  );
  const bothHands = !!(
    primaryHand?.stable &&
    secondaryHand?.stable &&
    handsApart
  );
  const offFingers = [false, false, false, false, false];

  let gesture = 'none';
  let present = false;
  let openness = 0;
  let source = 'none';
  const targets = [];
  let anyOpen = false;

  state.handCount = presentHands.length;
  state.bothHands = bothHands;
  state.secondaryGesture = secondaryHand?.gesture ?? 'none';

  if (debug.frozen) {
    gesture = debug.gesture ?? state.gesture;
    present = gesture !== 'none';
    anyOpen = gesture === 'open';
    state.fingers = state.demoMode
      ? gesture === 'open'
        ? [true, true, true, true, true]
        : offFingers
      : state.fingers;
    state.handCount = state.demoMode ? 1 : 0;
    state.bothHands = false;
    if (debug.pointer) {
      targets.push({
        id: 'debug',
        x: debug.pointer.x,
        y: debug.pointer.y,
        strength: 1,
        gesture,
        role: 'primary',
        source: 'debug',
      });
    }
    if (state.demoMode) {
      state.demoGesture = gesture;
      if (debug.pointer) {
        state.demoPointer.x = debug.pointer.x;
        state.demoPointer.y = debug.pointer.y;
      }
    }
  } else if (state.demoMode) {
    const demo = updateDemo(dt);
    gesture = demo.gesture;
    present = demo.present;
    state.fingers = demo.fingers;
    state.handPresent = true;
    state.handCount = 1;
    state.bothHands = false;
    anyOpen = gesture === 'open';
    source = 'demo';
    if (demo.active) {
      targets.push({
        id: 'demo-primary',
        x: demo.targetX,
        y: demo.targetY,
        strength: demo.strength,
        gesture,
        role: 'primary',
        source: 'demo',
      });
    }
  } else if (presentHands.length) {
    source = 'hand';
    state.handPresent = true;
    gesture = primaryHand?.gesture ?? 'none';
    present = !!primaryHand;
    openness = primaryHand?.openness ?? 0;
    state.fingers = primaryHand?.fingers ?? offFingers;
    anyOpen = presentHands.some((handInfo) => handInfo.gesture === 'open');

    for (const handInfo of presentHands) {
      if (!handInfo.pointerRaw) continue;
      const mapped = mapCameraPointer(handInfo.pointerRaw);
      targets.push({
        id: handInfo.id,
        x: mapped.x,
        y: mapped.y,
        strength: handInfo.gesture === 'open' ? 1.08 : 0.9,
        gesture: handInfo.gesture,
        role: handInfo.role,
        source: 'hand',
      });
    }
  } else if (mouse.active && performance.now() - mouse.lastAt < 2200) {
    source = 'mouse';
    gesture = 'none';
    present = false;
    state.fingers = offFingers;
    state.handPresent = false;
    state.handCount = 0;
    state.bothHands = false;
    targets.push({
      id: 'mouse',
      x: mouse.x,
      y: mouse.y,
      strength: 0.9,
      gesture: 'none',
      role: 'primary',
      source: 'mouse',
    });
  } else {
    state.handPresent = false;
    state.handCount = 0;
    state.bothHands = false;
    state.fingers = offFingers;
    if (handSnapshot && !handSnapshot.present) {
      openness = handSnapshot.openness;
    }
  }

  if (debug.frozen) {
    if (handSnapshot) state.handPresent = true;
    if (debug.gesture) present = true;
  }

  // Every fingertip owns a smooth pointer state, keyed by its stable hand id.
  for (const pointerState of pointerStates.values()) {
    pointerState.active = false;
  }

  for (const target of targets) {
    const pointerState = ensurePointerState(target.id, target.x, target.y, state.time);
    if (
      !pointerState.initialized ||
      state.time - pointerState.lastActiveAt > 0.45
    ) {
      pointerState.x = target.x;
      pointerState.y = target.y;
      pointerState.vx = 0;
      pointerState.vy = 0;
    }
    const targetDistance = Math.hypot(target.x - pointerState.x, target.y - pointerState.y);
    const targetSpeed = targetDistance / Math.max(dt, 0.001);
    const baseRate = target.source === 'hand' ? 21 : 23;
    const followRate = baseRate + clamp(targetSpeed / 170, 0, 9);
    const follow = 1 - Math.exp(-dt * followRate);
    const previousX = pointerState.x;
    const previousY = pointerState.y;
    pointerState.x = mix(pointerState.x, target.x, follow);
    pointerState.y = mix(pointerState.y, target.y, follow);
    const rawVx = (pointerState.x - previousX) / dt;
    const rawVy = (pointerState.y - previousY) / dt;
    pointerState.vx = mix(pointerState.vx, clamp(rawVx, -1500, 1500), 0.28);
    pointerState.vy = mix(pointerState.vy, clamp(rawVy, -1500, 1500), 0.28);
    pointerState.active = true;
    pointerState.initialized = true;
    pointerState.lastActiveAt = state.time;
    pointerState.lastSeenAt = state.time;
    pointerState.gesture = target.gesture;
    pointerState.role = target.role;
    pointerState.strength = mix(
      pointerState.strength,
      target.strength,
      1 - Math.exp(-dt * 7)
    );
    pointerState.press = mix(
      pointerState.press,
      1,
      1 - Math.exp(-dt * 10)
    );
  }

  for (const pointerState of pointerStates.values()) {
    if (pointerState.active) continue;
    pointerState.vx = mix(pointerState.vx, 0, 0.16);
    pointerState.vy = mix(pointerState.vy, 0, 0.16);
    pointerState.press = mix(
      pointerState.press,
      0,
      1 - Math.exp(-dt * 8)
    );
  }

  for (const [id, pointerState] of pointerStates) {
    if (
      !pointerState.active &&
      pointerState.press < 0.01 &&
      state.time - pointerState.lastSeenAt > 1.5
    ) {
      pointerStates.delete(id);
    }
  }

  const pointerList = [...pointerStates.values()];
  const primaryPointer =
    pointerList.find(
      (pointerState) => pointerState.active && pointerState.role === 'primary'
    ) ||
    pointerList.find((pointerState) => pointerState.active) ||
    pointerList[0] ||
    {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.455,
      vx: 0,
      vy: 0,
      active: false,
      strength: 1,
    };

  state.gesture = gesture;
  state.openness = openness;
  state.source = source;
  state.anyHandOpen = anyOpen;
  updateOrbit(dt, handSnapshot);
  const bothFists =
    bothHands &&
    primaryHand?.gesture === 'fist' &&
    secondaryHand?.gesture === 'fist';
  const wantsClose = bothHands ? bothFists : gesture === 'fist';

  if (state.resetting) {
    state.bloom = Math.max(0, state.bloom - dt / 1.45);
    if (state.bloom <= 0.0005) {
      state.resetting = false;
      elements.resetBtn.classList.remove('is-busy');
    }
  } else if (!debug.frozen) {
    if (state.closing) {
      if (anyOpen && state.time >= state.openCooldownUntil) {
        // Either palm opening interrupts the close; the flower continues from
        // wherever it stopped.
        state.closing = false;
        state.closeElapsed = 0;
      } else {
        state.closeElapsed += dt;
        const progress = clamp(state.closeElapsed / 3.15, 0, 1);
        state.bloom = 1 - easeInOutCubic(progress);
        if (progress >= 1) {
          state.closing = false;
          state.closeElapsed = 0;
          state.bloom = 0;
          state.closedAt = state.time;
          state.openedOnce = false;
          document.body.classList.remove('is-full');
        }
      }
    }

    if (!state.closing) {
      if (gesture === 'open' && state.time >= state.openCooldownUntil) {
        if (state.bloom < 1) {
          state.bloom = Math.min(1, state.bloom + dt / 2.95);
        }
      } else if (
        wantsClose &&
        state.bloom >= 0.999 &&
        state.openedOnce
      ) {
        state.closing = true;
        state.closeElapsed = 0;
        state.bloom = 1;
        showToast(
          bothHands ? '双掌收拢 · 花灵重新含苞' : '掌心收拢 · 花灵重新含苞',
          2200
        );
      }
    }
  }

  if (state.bloom >= 0.999 && !state.openedOnce) {
    state.openedOnce = true;
    document.body.classList.add('is-full');
    showToast(
      state.bothHands
        ? '花开正好 · 双手移动环绕，双拳重新含苞'
        : '花开正好 · 移动手掌环绕，握拳重新含苞',
      3000
    );
  }

  const pointerForFlower = {
    x: primaryPointer.x,
    y: primaryPointer.y,
    active: primaryPointer.active,
    vx: primaryPointer.vx,
    vy: primaryPointer.vy,
    strength: primaryPointer.strength,
  };

  flower.setPointer(pointerForFlower);
  const updateStart = performance.now();
  flower.update(dt, {
    bloom: state.bloom,
    time: state.time,
    pointer: pointerForFlower,
    pointers: pointerList,
    orbit: {
      yaw: state.orbitYaw,
      elevation: state.orbitElevation,
      offsetX: 0,
      offsetY: 0,
    },
  });
  const renderStart = performance.now();
  flower.render();
  state.updateMs = mix(state.updateMs, renderStart - updateStart, 0.2);
  state.renderMs = mix(state.renderMs, performance.now() - renderStart, 0.2);

  aura.update(dt, {
    pointers: pointerList,
    time: state.time,
  });

  dust.update(state.time, pointerForFlower, {
    yaw: state.orbitYaw,
    elevation: state.orbitElevation,
  });
  updateUi(now);
}

function bindEvents() {
  elements.startBtn?.addEventListener('click', startExperience);
  elements.demoBtn?.addEventListener('click', startDemo);
  elements.resetBtn?.addEventListener('click', resetBloom);

  elements.motionBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    setMotionPanel(!motionPanelOpen);
  });
  elements.motionClose?.addEventListener('click', () => setMotionPanel(false));
  elements.motionDefault?.addEventListener('click', () => {
    setOrbitSensitivity(1);
  });
  elements.motionRange?.addEventListener('input', (event) => {
    setOrbitSensitivity(Number(event.target.value) / 100);
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!motionPanelOpen) return;
      if (
        elements.motionPanel?.contains(event.target) ||
        elements.motionBtn?.contains(event.target)
      ) {
        return;
      }
      setMotionPanel(false);
    },
    { passive: true }
  );

  document.querySelectorAll('[data-noop]').forEach((link) => {
    link.addEventListener('click', (event) => event.preventDefault());
  });

  window.addEventListener(
    'pointermove',
    (event) => {
      if (!state.started) return;
      if (event.target.closest?.('button, a, input, .motion-panel, .topbar, .footer')) {
        return;
      }
      mouse.active = true;
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      mouse.lastAt = performance.now();
    },
    { passive: true }
  );

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!state.started) return;
      if (event.target.closest?.('button, a')) return;
      mouse.active = true;
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      mouse.lastAt = performance.now();
    },
    { passive: true }
  );

  window.addEventListener('pointerleave', () => {
    mouse.active = false;
  });

  window.addEventListener('blur', () => {
    mouse.active = false;
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'r' || event.key === 'R') {
      resetBloom();
    }
    if (event.key === 'Escape') {
      setMotionPanel(false);
    }
  });

  window.addEventListener('resize', () => {
    if (!state.started) return;
    updateUi(performance.now(), true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      mouse.active = false;
      for (const pointerState of pointerStates.values()) {
        pointerState.active = false;
      }
      lastFrameAt = performance.now();
    } else {
      lastFrameAt = performance.now();
    }
  });

  window.addEventListener('beforeunload', () => {
    hand?.stop();
  });
}

function exposeDebugApi() {
  window.__petal = {
    freeze() {
      debug.frozen = true;
      if (!state.started) startDemo();
    },
    unfreeze() {
      debug.frozen = false;
      debug.gesture = null;
      debug.pointer = null;
    },
    setBloom(value) {
      debug.frozen = true;
      state.closing = false;
      state.closeElapsed = 0;
      state.bloom = clamp(Number(value) || 0, 0, 1);
      state.openedOnce = state.bloom >= 0.999;
      if (!state.started) startDemo();
      updateUi(performance.now(), true);
      return state.bloom;
    },
    setOrbit(yawDegrees, elevationDegrees) {
      debug.orbit = {
        yaw: Number(yawDegrees) * DEG,
        elevation: Number(elevationDegrees) * DEG,
      };
      return { ...debug.orbit };
    },
    clearOrbit() {
      debug.orbit = null;
    },
    setGesture(gesture) {
      debug.frozen = true;
      debug.gesture = ['open', 'fist', 'none'].includes(gesture) ? gesture : 'none';
      state.gesture = debug.gesture;
      state.fingers =
        state.gesture === 'open'
          ? [true, true, true, true, true]
          : [false, false, false, false, false];
      updateUi(performance.now(), true);
      return state.gesture;
    },
    setPointer(x, y, active = true) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      debug.pointer = { x: Number(x) * w, y: Number(y) * h };
      debug.pointerActive = active;
      return debug.pointer;
    },
    reset: resetBloom,
    demo: startDemo,
    getFlower() {
      return flower;
    },
    getState() {
      return {
        bloom: state.bloom,
        gesture: state.gesture,
        handPresent: state.handPresent,
        handCount: state.handCount,
        bothHands: state.bothHands,
        secondaryGesture: state.secondaryGesture,
        hands: (hand?.getSnapshot?.().hands || []).map((item) => ({
          id: item.id,
          role: item.role,
          stable: item.stable,
          gesture: item.gesture,
          label: item.label,
          x: Number(item.palmRaw?.x?.toFixed(3)),
          y: Number(item.palmRaw?.y?.toFixed(3)),
        })),
        started: state.started,
        demo: state.demoMode,
        closing: state.closing,
        orbitYaw: Number((state.orbitYaw / DEG).toFixed(2)),
        orbitElevation: Number((state.orbitElevation / DEG).toFixed(2)),
        orbitTargetYaw: Number((state.orbitTargetYaw / DEG).toFixed(2)),
        orbitTargetElevation: Number(
          (state.orbitTargetElevation / DEG).toFixed(2)
        ),
        orbitActiveHandId: state.orbitActiveHandId,
        orbitSensitivity: state.orbitSensitivity,
        fps: state.fps,
        detectMs: Number(state.detectMs.toFixed(2)),
        detectCost: Number((hand?.getSnapshot?.().lastCost || 0).toFixed(2)),
        detectInterval: hand?.detectInterval ?? 0,
        detectorMode: hand?.detectorMode ?? 'none',
        delegate: hand?.delegate ?? 'none',
        updateMs: Number(state.updateMs.toFixed(2)),
        renderMs: Number(state.renderMs.toFixed(2)),
        fingers: state.fingers,
        particles: flower?.getParticleCount?.() ?? 0,
      };
    },
  };
}

function init() {
  try {
    flower = new FlowerField($('#flower'));
    dust = new DustField($('#dust'));
    aura = new HandAura($('#aura'));
  } catch (error) {
    console.error(error);
    setIntroStatus('这个浏览器无法创建 WebGL 2 花海，请换用最新版 Chrome 或 Edge。', true);
    if (elements.startBtn) {
      elements.startBtn.disabled = true;
      elements.startBtn.style.opacity = '0.45';
    }
    return;
  }

  hand = new HandTracker({
    video: $('#camera'),
    previewCanvas: $('#hand-preview'),
    onProgress: (stage, text) => {
      if (state.started) return;
      if (stage === 'camera') setIntroStatus('正在连接镜头…');
      if (stage === 'model') setIntroStatus('正在装载手势感知…');
      if (stage === 'ready') setIntroStatus('花灵已就绪');
    },
  });

  bindEvents();
  if (debugApi) exposeDebugApi();
  setOrbitSensitivity(state.orbitSensitivity, false);
  updateUi(performance.now(), true);

  if (wantsDemo) {
    window.setTimeout(startDemo, 260);
  } else {
    // If the browser already remembers permission, entering the experience
    // feels immediate.  Otherwise the intro's button is the permission gesture.
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'camera' })
        .then((permission) => {
          if (permission.state === 'granted' && !state.started) {
            window.setTimeout(startExperience, 420);
          }
        })
        .catch(() => {});
    }
  }

  lastFrameAt = performance.now();
  rafId = requestAnimationFrame(frame);
}

init();
