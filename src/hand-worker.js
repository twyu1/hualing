import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// Vite's dev server runs this file as a module worker, where importScripts is
// unavailable. MediaPipe's wasm loader still expects it, so provide a small
// synchronous loader for same-origin scripts.
const loadWorkerScript = (...urls) => {
  for (const url of urls) {
    const request = new XMLHttpRequest();
    request.open('GET', String(url), false);
    request.send(null);
    if (request.status < 200 || request.status >= 300) {
      throw new Error(`Could not load worker script: ${url}`);
    }
    const factory = (0, eval)(
      `${request.responseText}\n;typeof ModuleFactory === "function" ? ModuleFactory : undefined;`
    );
    if (typeof factory === 'function') {
      self.ModuleFactory = factory;
    }
  }
};

// A module worker may still expose a native importScripts that throws a
// TypeError. Override it in that case as well so MediaPipe's loader takes the
// synchronous path and sets ModuleFactory.
try {
  Object.defineProperty(self, 'importScripts', {
    configurable: true,
    writable: true,
    value: loadWorkerScript,
  });
} catch {
  try {
    self.importScripts = loadWorkerScript;
  } catch {
    // The platform does not allow overriding it; classic workers work natively.
  }
}

let landmarker = null;
let delegate = 'CPU';
let lastTimestamp = -1;

function optionsFor(baseUrl, chosenDelegate) {
  return {
    baseOptions: {
      modelAssetPath: baseUrl.model,
      delegate: chosenDelegate,
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.52,
  };
}

async function init(baseUrl) {
  const vision = await FilesetResolver.forVisionTasks(baseUrl.wasm);
  try {
    landmarker = await HandLandmarker.createFromOptions(
      vision,
      optionsFor(baseUrl, 'CPU')
    );
    delegate = 'CPU';
  } catch (cpuError) {
    landmarker = await HandLandmarker.createFromOptions(
      vision,
      optionsFor(baseUrl, 'GPU')
    );
    delegate = 'GPU';
  }
  self.postMessage({ type: 'ready', delegate });
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      await init(message.baseUrl);
    } catch (error) {
      self.postMessage({
        type: 'error',
        stage: 'init',
        message: error?.message || String(error),
      });
    }
    return;
  }

  if (message.type !== 'frame') return;
  const { bitmap, timestamp, id } = message;
  if (!landmarker) {
    bitmap.close?.();
    self.postMessage({
      type: 'error',
      stage: 'frame',
      id,
      message: 'Hand landmarker is not ready.',
    });
    return;
  }

  const startedAt = performance.now();
  try {
    // detectForVideo requires strictly increasing timestamps.
    lastTimestamp = Math.max(timestamp, lastTimestamp + 0.1);
    const result = landmarker.detectForVideo(bitmap, lastTimestamp);
    self.postMessage({
      type: 'result',
      id,
      delegate,
      cost: performance.now() - startedAt,
      result: {
        landmarks: result?.landmarks || [],
        worldLandmarks: result?.worldLandmarks || [],
        handedness: result?.handedness || result?.handednesses || [],
      },
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      stage: 'frame',
      id,
      message: error?.message || String(error),
    });
  } finally {
    bitmap.close?.();
  }
};
