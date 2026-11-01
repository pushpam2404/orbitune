// src/renderer/universeScene.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** True when this browser can create a WebGL context at all. */
export function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
  } catch {
    return false;
  }
}

export function createUniverseScene(canvasContainer) {
  // 1. Scene
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x040409, 0.0006);

  // 2. Camera
  const camera = new THREE.PerspectiveCamera(
    52,
    window.innerWidth / window.innerHeight,
    0.1,
    6000
  );
  camera.position.set(0, 160, 320);

  // 3. WebGLRenderer
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(maxPixelRatio());
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  canvasContainer.appendChild(renderer.domElement);

  // A lost GPU context (driver reset, too many tabs) leaves a blank canvas. Say so, and
  // let the browser restore it: three.js re-uploads its buffers when it comes back.
  const fallback = document.getElementById('webgl-fallback');
  const fallbackText = document.getElementById('webgl-fallback-text');
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    if (fallbackText) fallbackText.textContent = 'The graphics context was lost. Orbitune will redraw as soon as the browser gives it back; if it does not, reload the page.';
    if (fallback) fallback.hidden = false;
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    if (fallback) fallback.hidden = true;
  });

  // 4. Orbit Controls (tuned for both desktop mouse and mobile one-finger orbit / two-finger pinch+pan)
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = isCoarsePointer ? 0.085 : 0.06;
  controls.minDistance = 5;
  controls.maxDistance = 850;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = isCoarsePointer ? 0.85 : 1.0;
  controls.zoomSpeed = isCoarsePointer ? 1.3 : 1.0;
  controls.panSpeed = isCoarsePointer ? 0.95 : 1.0;
  // Disable zoomToCursor on touch devices so two-finger pinch-zoom zooms smoothly
  // toward the current target rather than throwing the galaxy sideways off-screen.
  controls.zoomToCursor = !isCoarsePointer;
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN
  };
  // A slow turn makes the depth readable; the Motion slider controls its speed.
  // (Left off when the system asks for reduced motion; the slider can still turn it on.)
  controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = 0.35;

  // 5. Ambient & Directional Lighting
  const ambientLight = new THREE.AmbientLight(0x222238, 1.2);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(120, 150, 100);
  scene.add(keyLight);

  // 6. Volumetric Deep-Space Starfield
  const starfield = createStarfield();
  scene.add(starfield);

  // Handle Resize
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    renderer.setPixelRatio(maxPixelRatio());
  });

  return { scene, camera, renderer, controls, starfield };
}

function createStarfield() {
  const starCount = 3800;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  const starHues = [
    new THREE.Color('#FFFFFF'),
    new THREE.Color('#00F0FF'),
    new THREE.Color('#FF007F'),
    new THREE.Color('#FFB800'),
    new THREE.Color('#7928CA')
  ];

  for (let i = 0; i < starCount; i++) {
    const i3 = i * 3;
    const radius = 1600 + Math.random() * 1600;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i3 + 2] = radius * Math.cos(phi);

    const chosenColor = starHues[Math.floor(Math.random() * starHues.length)];
    colors[i3] = chosenColor.r;
    colors[i3 + 1] = chosenColor.g;
    colors[i3 + 2] = chosenColor.b;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 3.2,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
    fog: false
  });

  return new THREE.Points(geometry, material);
}

/** Phones have very dense screens and small GPUs: 1.5× looks the same and keeps it smooth. */
function maxPixelRatio() {
  return Math.min(window.devicePixelRatio, window.matchMedia('(pointer: coarse)').matches ? 1.5 : 2);
}
