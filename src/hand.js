import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import HandWorker from './hand-worker.js?worker';

const TAU = Math.PI * 2;
const BASE = import.meta.env.BASE_URL;

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const FINGERS = [
  { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
  { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
  { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleBetween(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const la = Math.hypot(abx, aby) || 1;
  const lc = Math.hypot(cbx, cby) || 1;
  return Math.acos(clamp((abx * cbx + aby * cby) / (la * lc), -1, 1));
}

function averagePoints(points, indices) {
  let x = 0;
  let y = 0;
  for (const index of indices) {
    x += points[index].x;
    y += points[index].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

export class HandTracker {
  constructor({ video, previewCanvas, onProgress }) {
    this.video = video;
    this.previewCanvas = previewCanvas;
    this.previewCtx = previewCanvas.getContext('2d');
    this.onProgress = onProgress || (() => {});

    this.landmarker = null;
    this.stream = null;
    this.detectCanvas = document.createElement('canvas');
    this.detectCtx = this.detectCanvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });
    this.detectCanvas.width = 384;
    this.detectCanvas.height = 288;
    this.started = false;
    this.ready = false;
    this.cameraReady = false;
    this.modelReady = false;
    this.cameraLabel = '';
    this.detectorMode = 'main';
    this.worker = null;
    this.workerReady = false;
    this.workerBusy = false;
    this.workerFrameId = 0;
    this.workerInitResolve = null;
    this.workerInitReject = null;
    this.workerFallbackStarted = false;
    this.workerBaseUrl = null;
    this.workerFrameErrors = 0;
    this.detectionId = 0;
    this.detectionAt = 0;

    this.landmarks = null;
    this.worldLandmarks = null;
    this.present = false;
    this.gesture = 'none';
    this.openness = 0;
    this.fingers = [false, false, false, false, false];
    this.mainExtended = 0;
    this.pointerRaw = null;
    this.pointerTip = null;
    this.palm = null;
    this.palmRaw = null;
    this.error = null;
    this.delegate = 'GPU';

    // Two-hand tracking. Each track keeps its own gesture filters so hands
    // never share (or reset) each other's state.
    this.tracks = [];
    this.hands = [];
    this.nextHandId = 1;
    this.primaryId = null;
    this.secondaryId = null;
    this.primaryMissingSince = 0;
    this.missingFrames = 0;
    this.openFrames = 0;
    this.fistFrames = 0;
    this.lastTimestamp = -1;
    this.lastVideoTime = -1;
    this.lastDetectAt = 0;
    this.lastCost = 0;
    this.detectInterval = 33;
    this.previewW = 0;
    this.previewH = 0;
    this.running = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.onProgress('camera', '正在与镜头建立连接');
    const cameraPromise = this._startCamera();
    const modelPromise = this._startDetector();
    let cameraError = null;

    try {
      await cameraPromise;
    } catch (error) {
      cameraError = error;
      this.error = this._friendlyError(error);
    }

    try {
      await modelPromise;
    } catch (error) {
      this.started = false;
      if (!this.error) this.error = this._friendlyError(error);
      throw Object.assign(new Error(this.error), { cause: error });
    }

    if (cameraError) {
      this.started = false;
      throw Object.assign(new Error(this.error), { cause: cameraError });
    }

    this.ready = true;
    this.running = true;
    this.onProgress('ready', '花灵已就绪');
  }

  async _startDetector() {
    this.onProgress('model', '正在装载手势感知');

    if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        await this._startWorker();
        this.detectorMode = 'worker';
        this.modelReady = true;
        return;
      } catch (error) {
        console.warn('Hand worker unavailable, using the main thread.', error);
        this._disposeWorker();
      }
    }

    await this._loadModel();
    this.detectorMode = 'main';
    this.modelReady = true;
  }

  _startWorker() {
    return new Promise((resolve, reject) => {
      const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
      this.workerBaseUrl = {
        wasm: new URL('wasm/', baseUrl).href,
        model: new URL('models/hand_landmarker.task', baseUrl).href,
      };

      const worker = new HandWorker();
      this.worker = worker;
      this.workerInitResolve = resolve;
      this.workerInitReject = reject;

      const timer = window.setTimeout(() => {
        this.workerInitReject?.(new Error('Hand worker startup timed out.'));
        this.workerInitResolve = null;
        this.workerInitReject = null;
        reject(new Error('Hand worker startup timed out.'));
      }, 15000);

      const settle = (callback, value) => {
        window.clearTimeout(timer);
        this.workerInitResolve = null;
        this.workerInitReject = null;
        callback(value);
      };

      worker.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'ready') {
          this.workerReady = true;
          this.delegate = message.delegate || 'CPU';
          settle(resolve);
          return;
        }
        this._handleWorkerMessage(message);
      });

      worker.addEventListener('error', (event) => {
        console.warn('Hand worker failed.', event);
        this.workerReady = false;
        this.workerBusy = false;
        this.workerInitReject?.(
          new Error(event.message || 'Hand worker failed.')
        );
        if (this.detectorMode === 'worker') {
          this._fallbackToMainDetector();
        }
      });

      worker.postMessage({ type: 'init', baseUrl: this.workerBaseUrl });
    });
  }

  _handleWorkerMessage(message) {
    if (message.type === 'result') {
      this.workerBusy = false;
      this.lastCost = message.cost || 0;
      this.delegate = message.delegate || this.delegate;
      if (this.running) {
        this._consume(message.result, performance.now());
      }
      return;
    }

    if (message.type === 'error') {
      this.workerBusy = false;
      console.warn('Hand worker frame failed.', message.message);
      if (message.stage === 'init') {
        this.workerReady = false;
        this.workerInitReject?.(new Error(message.message));
      }
    }
  }

  async _fallbackToMainDetector() {
    if (this.workerFallbackStarted) return;
    this.workerFallbackStarted = true;
    this.workerReady = false;
    this.workerBusy = false;
    this._disposeWorker();
    this.detectorMode = 'main';
    try {
      await this._loadModel();
      this.modelReady = true;
    } catch (error) {
      console.warn('Main-thread hand fallback failed.', error);
    }
  }

  _disposeWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerReady = false;
    this.workerBusy = false;
  }

  async _loadModel() {
    this.onProgress('model', '正在装载手势感知');
    const vision = await FilesetResolver.forVisionTasks(`${BASE}wasm`);

    const create = async (delegate) =>
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `${BASE}models/hand_landmarker.task`,
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.58,
        minHandPresenceConfidence: 0.58,
        minTrackingConfidence: 0.55,
      });

    try {
      this.landmarker = await create('GPU');
      this.delegate = 'GPU';
    } catch (gpuError) {
      console.warn('GPU delegate unavailable, falling back to CPU.', gpuError);
      this.onProgress('model', '正在切换至 CPU 追踪');
      this.landmarker = await create('CPU');
      this.delegate = 'CPU';
    }

    this.modelReady = true;
  }

  _cameraCandidates(devices, initialLabel) {
    return devices
      .map((device) => {
        const label = device.label || '';
        let score = 0;
        if (/integrated|built[- ]?in|内置|笔记本|facetime|front/i.test(label)) {
          score += 120;
        }
        if (/usb|hd webcam|webcam|camera/i.test(label)) score += 25;
        if (
          /virtual|obs|webcast|smart connect|iriun|droidcam|epoc|manycam|snap camera|mmhmm/i.test(
            label
          )
        ) {
          score -= 140;
        }
        if (label === initialLabel) score += 4;
        return {
          deviceId: device.deviceId,
          groupId: device.groupId,
          kind: device.kind,
          label,
          score,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  _videoConstraints(deviceId) {
    return {
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: 640, max: 960 },
        height: { ideal: 480, max: 540 },
        frameRate: { ideal: 30, max: 30 },
      },
    };
  }

  async _startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API is not available.');
    }

    let initial;
    try {
      initial = await navigator.mediaDevices.getUserMedia(this._videoConstraints());
    } catch (error) {
      if (error?.name === 'OverconstrainedError') {
        initial = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        });
      } else {
        throw error;
      }
    }

    const initialTrack = initial.getVideoTracks()[0];
    const initialLabel = initialTrack?.label || '';
    let stream = initial;
    let chosenLabel = initialLabel;

    // Windows can rank a virtual camera (e.g. "Smart Connect Camera") above the
    // built-in webcam.  Prefer the real integrated camera so the hand is
    // actually visible, and fall back through the other devices if it is busy.
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === 'videoinput'
      );
      const candidates = this._cameraCandidates(devices, initialLabel);

      for (const candidate of candidates) {
        if (!candidate.deviceId || candidate.label === initialLabel) continue;
        if (candidate.score < 0 && initialLabel) continue;
        try {
          const alternate = await navigator.mediaDevices.getUserMedia(
            this._videoConstraints(candidate.deviceId)
          );
          const alternateTrack = alternate.getVideoTracks()[0];
          if (!alternateTrack) {
            alternate.getTracks().forEach((track) => track.stop());
            continue;
          }
          initial.getTracks().forEach((track) => track.stop());
          stream = alternate;
          chosenLabel = alternateTrack.label || candidate.label;
          break;
        } catch (cameraError) {
          console.warn(`Camera "${candidate.label}" is unavailable.`, cameraError);
        }
      }
    } catch (error) {
      console.warn('Could not enumerate video devices.', error);
    }

    this.stream = stream;
    this.cameraLabel = chosenLabel;
    const video = this.video;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    await new Promise((resolve, reject) => {
      if (video.readyState >= 1 && video.videoWidth) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('The camera stream did not deliver a video frame.'));
      }, 7000);
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('The camera stream could not be read.'));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    await video.play().catch(() => {});
    this.cameraReady = true;
  }

  _friendlyError(error) {
    if (!window.isSecureContext) {
      return '摄像头需要在本机 localhost 或 HTTPS 页面中运行。';
    }
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      return '摄像头权限被拒绝。允许权限后刷新页面，或先使用演示模式。';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
      return '没有找到可用的摄像头，可以先体验演示模式。';
    }
    if (error?.name === 'NotReadableError' || error?.name === 'AbortError') {
      return '摄像头正被其他程序占用，请关闭占用后重试。';
    }
    return '镜头或手势模型未能启动，请重试或使用演示模式。';
  }

  detect(now) {
    if (!this.running || !this.cameraReady) return;
    if (this.detectorMode === 'worker') {
      if (!this.workerReady) return;
      if (this.workerBusy && now - this.lastDetectAt > 900) {
        this.workerBusy = false;
        this.workerFrameErrors += 1;
        if (this.workerFrameErrors >= 3) {
          this._fallbackToMainDetector();
          return;
        }
      }
    } else if (!this.landmarker) {
      return;
    }
    if (now - this.lastDetectAt < this.detectInterval) return;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    if (this.video.currentTime === this.lastVideoTime) return;

    this.lastDetectAt = now;
    this.lastVideoTime = this.video.currentTime;
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 0.1);

    if (this.detectorMode === 'worker') {
      this._sendWorkerFrame();
      return;
    }

    try {
      const startedAt = performance.now();
      const videoW = this.video.videoWidth || 16;
      const videoH = this.video.videoHeight || 9;
      const detectW = 384;
      const detectH = Math.max(1, Math.round((detectW * videoH) / videoW));
      if (
        this.detectCanvas.width !== detectW ||
        this.detectCanvas.height !== detectH
      ) {
        this.detectCanvas.width = detectW;
        this.detectCanvas.height = detectH;
      }
      this.detectCtx.drawImage(this.video, 0, 0, detectW, detectH);
      const result = this.landmarker.detectForVideo(
        this.detectCanvas,
        this.lastTimestamp
      );
      this.lastCost = performance.now() - startedAt;
      this._consume(result, this.lastDetectAt);
    } catch (error) {
      console.warn('Hand tracking frame failed.', error);
    }
  }

  _sendWorkerFrame() {
    if (!this.workerReady || !this.worker || this.workerBusy) return;
    this.workerBusy = true;

    const videoW = this.video.videoWidth || 16;
    const videoH = this.video.videoHeight || 9;
    const targetWidth = 480;
    const targetHeight = Math.max(1, Math.round((targetWidth * videoH) / videoW));
    const timestamp = this.lastTimestamp;
    const send = (bitmap) => {
      if (!this.worker || !this.workerReady) {
        bitmap.close?.();
        this.workerBusy = false;
        return;
      }
      const id = this.workerFrameId + 1;
      this.workerFrameId = id;
      try {
        this.worker.postMessage({ type: 'frame', bitmap, timestamp, id }, [
          bitmap,
        ]);
      } catch (error) {
        bitmap.close?.();
        this.workerBusy = false;
        console.warn('Could not hand a frame to the worker.', error);
      }
    };

    if (typeof createImageBitmap === 'function') {
      createImageBitmap(this.video, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'low',
      })
        .then(send)
        .catch(() => {
          // Older implementations do not accept resize options.
          createImageBitmap(this.video)
            .then(send)
            .catch((error) => {
              this.workerBusy = false;
              this.workerFrameErrors += 1;
              console.warn('Could not capture a hand frame.', error);
              if (this.workerFrameErrors >= 3) {
                this._fallbackToMainDetector();
              }
            });
        });
      return;
    }

    this.workerBusy = false;
    this._fallbackToMainDetector();
  }

  _consume(result, now = performance.now()) {
    this.detectionId += 1;
    this.detectionAt = now;
    const rawHands = result?.landmarks || [];
    const handedness = result?.handedness || result?.handednesses || [];
    const aspect = (this.video.videoWidth || 16) / (this.video.videoHeight || 9);
    const detections = rawHands.map((landmarks, index) => {
      const category = handedness[index]?.[0];
      return {
        ...this._analyzeHand(landmarks, category?.categoryName || '', aspect),
        label: category?.categoryName || '',
      };
    });

    const assignedTracks = new Set();
    const assignedDetections = new Set();
    const pairs = [];

    for (let di = 0; di < detections.length; di += 1) {
      for (const track of this.tracks) {
        if (!track.palmRaw) continue;
        const detection = detections[di];
        const distance = Math.hypot(
          (detection.palmRaw.x - track.palmRaw.x) * 1.08,
          detection.palmRaw.y - track.palmRaw.y
        );
        const labelPenalty =
          track.label && detection.label && track.label !== detection.label
            ? 0.22
            : 0;
        pairs.push({ di, track, cost: distance + labelPenalty });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);

    for (const pair of pairs) {
      if (pair.cost > 0.62) continue;
      if (assignedDetections.has(pair.di) || assignedTracks.has(pair.track.id)) {
        continue;
      }
      const detection = detections[pair.di];
      assignedDetections.add(pair.di);
      assignedTracks.add(pair.track.id);
      this._applyDetection(pair.track, detection, now);
    }

    for (let di = 0; di < detections.length; di += 1) {
      if (assignedDetections.has(di)) continue;
      const detection = detections[di];
      const track = {
        id: `hand-${this.nextHandId}`,
        label: detection.label,
        firstSeenAt: now,
        lastSeenAt: now,
        presentSince: now,
        stable: false,
        present: true,
        missingFrames: 0,
        gesture: 'none',
        openFrames: 0,
        fistFrames: 0,
        openness: detection.openness,
        ...detection,
      };
      this.nextHandId += 1;
      this._updateTrackGesture(track, detection.openness, detection.mainExtended);
      this.tracks.push(track);
      assignedTracks.add(track.id);
    }

    for (const track of this.tracks) {
      if (assignedTracks.has(track.id)) continue;
      track.missingFrames += 1;
      if (track.missingFrames >= 4) {
        track.present = false;
        track.stable = false;
        track.gesture = 'none';
        track.openness *= 0.5;
        track.fingers = [false, false, false, false, false];
        track.mainExtended = 0;
        track.openFrames = 0;
        track.fistFrames = 0;
      }
    }

    this.tracks = this.tracks.filter((track) => {
      if (track.present) return true;
      return now - track.lastSeenAt < 1200;
    });
    this.tracks.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id));

    this._refreshRoles(now);
    this._syncLegacy();
  }

  _analyzeHand(hand, label, aspect) {
    const pts = hand.map((point) => ({ x: point.x * aspect, y: point.y }));
    const palm = averagePoints(pts, [0, 5, 9, 13, 17]);
    const handScale = Math.max(0.02, dist(pts[0], pts[9]));
    const palmRaw = { x: palm.x / aspect, y: palm.y };

    const scores = [];
    const fingers = [];
    let mainExtended = 0;

    for (const finger of FINGERS) {
      const mcp = pts[finger.mcp];
      const pip = pts[finger.pip];
      const tip = pts[finger.tip];
      const angle = angleBetween(mcp, pip, tip);
      const lengthRatio = dist(pts[0], tip) / Math.max(0.001, dist(pts[0], pip));
      const angleScore = smoothstep(1.68, 2.82, angle);
      const lengthScore = smoothstep(0.94, 1.34, lengthRatio);
      const score = clamp(angleScore * 0.62 + lengthScore * 0.38, 0, 1);
      const extended = score > 0.54 && angle > 1.9;
      scores.push(score);
      fingers.push(extended);
      if (extended) mainExtended += 1;
    }

    // The thumb is scored a little more forgivingly; it is frequently hidden.
    const thumbAngle = angleBetween(pts[2], pts[3], pts[4]);
    const thumbSpread = dist(pts[4], pts[5]) / handScale;
    const thumbScore = clamp(
      smoothstep(1.5, 2.93, thumbAngle) * 0.56 +
        smoothstep(0.62, 1.3, thumbSpread) * 0.44,
      0,
      1
    );
    const thumbExtended = thumbScore > 0.53;
    scores.push(thumbScore);
    fingers.push(thumbExtended);

    const openness = clamp(
      (scores.slice(0, 4).reduce((sum, value) => sum + value, 0) + thumbScore * 0.65) /
        4.65,
      0,
      1
    );

    // When the hand is open the fingertip leads; when it is a fist the palm
    // becomes the point of contact. Interpolating avoids a sudden jump.
    const indexScore = scores[0];
    const tip = pts[8];
    const blend = 0.18 + 0.77 * smoothstep(0.18, 0.8, indexScore);
    const pointerRaw = {
      x: mix(palm.x, tip.x, blend) / aspect,
      y: mix(palm.y, tip.y, blend),
    };
    const pointerTip = { x: hand[8].x, y: hand[8].y };

    return {
      landmarks: hand,
      label,
      pts,
      palm,
      palmRaw,
      pointerRaw,
      pointerTip,
      openness,
      mainExtended,
      fingers: [thumbExtended, ...fingers.slice(0, 4)],
      extendedTotal: mainExtended + (thumbExtended ? 1 : 0),
    };
  }

  _applyDetection(track, detection, now) {
    const wasPresent = track.present;
    Object.assign(track, detection);
    track.present = true;
    track.missingFrames = 0;
    track.lastSeenAt = now;
    if (!wasPresent) track.presentSince = now;
    track.stable = now - track.presentSince >= 350;
    this._updateTrackGesture(track, detection.openness, detection.mainExtended);
  }

  _updateTrackGesture(track, rawOpenness, mainExtended) {
    track.openness = mix(track.openness, rawOpenness, 0.48);

    if (track.gesture !== 'open') {
      const opening =
        (mainExtended >= 3 && track.openness > 0.52) || track.openness > 0.7;
      track.openFrames = opening ? track.openFrames + 1 : 0;
      if (track.openFrames >= 2) {
        track.gesture = 'open';
        track.fistFrames = 0;
      }
    }

    if (track.gesture !== 'fist') {
      const closing =
        (mainExtended <= 1 && track.openness < 0.34) || track.openness < 0.22;
      track.fistFrames = closing ? track.fistFrames + 1 : 0;
      if (track.fistFrames >= 3) {
        track.gesture = 'fist';
        track.openFrames = 0;
      }
    }
  }

  _refreshRoles(now) {
    const present = this.tracks.filter((track) => track.present);
    let primaryTrack = this.tracks.find((track) => track.id === this.primaryId);

    if (!primaryTrack) {
      primaryTrack = present[0] || null;
      this.primaryId = primaryTrack?.id ?? null;
      this.primaryMissingSince = primaryTrack ? 0 : now;
    } else if (primaryTrack.present) {
      // A hand that was primary before a temporary loss regains priority.
      if (present[0] && present[0].firstSeenAt < primaryTrack.firstSeenAt) {
        primaryTrack = present[0];
        this.primaryId = primaryTrack.id;
      }
      this.primaryMissingSince = 0;
    } else {
      if (!this.primaryMissingSince) this.primaryMissingSince = now;
      if (now - this.primaryMissingSince >= 800 && present.length) {
        primaryTrack = present[0];
        this.primaryId = primaryTrack.id;
        this.primaryMissingSince = 0;
      }
    }

    if (!primaryTrack && present.length) {
      primaryTrack = present[0];
      this.primaryId = primaryTrack.id;
      this.primaryMissingSince = 0;
    }

    this.hands = present;
    this.secondaryId =
      present.find((track) => track.id !== this.primaryId)?.id ?? null;
  }

  _syncLegacy() {
    const primary = this.tracks.find(
      (track) => track.present && track.id === this.primaryId
    );
    this.present = !!primary;
    this.landmarks = primary?.landmarks ?? null;
    this.worldLandmarks = null;
    this.gesture = primary?.gesture ?? 'none';
    this.openness = primary?.openness ?? 0;
    this.fingers = primary?.fingers ?? [false, false, false, false, false];
    this.mainExtended = primary?.mainExtended ?? 0;
    this.extendedTotal = primary?.extendedTotal ?? 0;
    this.pointerRaw = primary?.pointerRaw ?? null;
    this.pointerTip = primary?.pointerTip ?? null;
    this.palm = primary?.palm ?? null;
    this.palmRaw = primary?.palmRaw ?? null;
  }

  _snapshotHand(track, role) {
    if (!track) return null;
    return {
      id: track.id,
      present: track.present,
      stable: track.stable,
      role,
      label: track.label,
      gesture: track.gesture,
      openness: track.openness,
      fingers: track.fingers,
      mainExtended: track.mainExtended,
      extendedTotal: track.extendedTotal,
      pointerRaw: track.pointerRaw,
      palmRaw: track.palmRaw,
      pointerTip: track.pointerTip,
      landmarks: track.landmarks,
    };
  }

  getSnapshot() {
    const primaryTrack = this.tracks.find(
      (track) => track.present && track.id === this.primaryId
    );
    const secondaryTrack = this.tracks.find(
      (track) => track.present && track.id === this.secondaryId
    );
    const hands = this.hands.map((track) =>
      this._snapshotHand(
        track,
        track.id === this.primaryId ? 'primary' : 'secondary'
      )
    );

    return {
      ready: this.ready,
      present: this.present,
      gesture: this.gesture,
      openness: this.openness,
      fingers: this.fingers,
      extendedTotal: this.extendedTotal || 0,
      pointerRaw: this.pointerRaw,
      palmRaw: this.palmRaw,
      pointerTip: this.pointerTip,
      delegate: this.delegate,
      detectorMode: this.detectorMode,
      cameraLabel: this.cameraLabel,
      lastCost: this.lastCost,
      detectionId: this.detectionId,
      detectionAt: this.detectionAt,
      hands,
      primary: this._snapshotHand(primaryTrack, 'primary'),
      secondary: this._snapshotHand(secondaryTrack, 'secondary'),
    };
  }

  drawPreview() {
    const ctx = this.previewCtx;
    const canvas = this.previewCanvas;
    if (!ctx) return;

    const cssW = Math.max(1, canvas.clientWidth);
    const cssH = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const pixelW = Math.round(cssW * dpr);
    const pixelH = Math.round(cssH * dpr);

    if (this.previewW !== pixelW || this.previewH !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
      this.previewW = pixelW;
      this.previewH = pixelH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!this.hands.length) return;

    const videoW = this.video.videoWidth || 16;
    const videoH = this.video.videoHeight || 9;
    const coverScale = Math.max(cssW / videoW, cssH / videoH);
    const drawW = videoW * coverScale;
    const drawH = videoH * coverScale;
    const ox = (cssW - drawW) * 0.5;
    const oy = (cssH - drawH) * 0.5;
    const map = (point) => ({
      x: ox + (1 - point.x) * drawW,
      y: oy + point.y * drawH,
    });

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const hand of this.hands) {
      if (!hand.landmarks) continue;
      const primary = hand.id === this.primaryId;
      const points = hand.landmarks.map(map);

      // Soft outer ray. A wide translucent stroke replaces shadowBlur, which
      // is disproportionately expensive on small preview canvases.
      ctx.strokeStyle = primary
        ? 'rgba(255, 111, 158, 0.14)'
        : 'rgba(255, 203, 139, 0.11)';
      ctx.lineWidth = primary ? 4.2 : 3.6;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(points[a].x, points[a].y);
        ctx.lineTo(points[b].x, points[b].y);
      }
      ctx.stroke();

      // Fine inner line.
      ctx.strokeStyle = primary
        ? 'rgba(255, 209, 225, 0.62)'
        : 'rgba(255, 233, 199, 0.52)';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(points[a].x, points[a].y);
        ctx.lineTo(points[b].x, points[b].y);
      }
      ctx.stroke();

      for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        const tip = [4, 8, 12, 16, 20].includes(i);
        const radius = tip ? 2.1 : 1.15;
        ctx.fillStyle = primary
          ? tip
            ? 'rgba(255, 236, 243, 0.95)'
            : 'rgba(255, 188, 211, 0.7)'
          : tip
            ? 'rgba(255, 241, 218, 0.9)'
            : 'rgba(255, 210, 160, 0.62)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, TAU);
        ctx.fill();
        if (tip) {
          ctx.fillStyle = primary
            ? 'rgba(255, 154, 189, 0.16)'
            : 'rgba(255, 194, 124, 0.13)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5.2, 0, TAU);
          ctx.fill();
        }
      }

      const tipPoint = points[8];
      const pulse = (primary ? 6.5 : 5.6) + Math.sin(performance.now() * 0.004) * 1.2;
      ctx.strokeStyle = primary
        ? hand.gesture === 'open'
          ? 'rgba(255, 220, 234, 0.75)'
          : hand.gesture === 'fist'
            ? 'rgba(255, 190, 211, 0.35)'
            : 'rgba(255, 190, 211, 0.5)'
        : 'rgba(255, 218, 169, 0.48)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(tipPoint.x, tipPoint.y, pulse, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  stop() {
    this.running = false;
    this._disposeWorker();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.landmarker) {
      this.landmarker.close?.();
      this.landmarker = null;
    }
    this.video.srcObject = null;
    this.cameraReady = false;
    this.cameraLabel = '';
    this.ready = false;
    this.started = false;
    this.tracks = [];
    this.hands = [];
    this.primaryId = null;
    this.secondaryId = null;
    this.primaryMissingSince = 0;
  }
}
