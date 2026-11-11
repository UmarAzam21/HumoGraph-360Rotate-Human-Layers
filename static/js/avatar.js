// Holographic anatomy avatar (human.glb) that reacts to the voice agent and exposes
// viewer controls: camera, layers, part selection, cross-section, explode, skin, mouth.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// Parts carried by the mandible when the mouth opens.
const JAW_PARTS = /^(mandible|tongue|.*lower.*tooth|.*mentalis|anterior_belly_of_.*digastric|.*mylohyoid|.*geniohyoid|.*depressor_labii|.*depressor_anguli)/i;

const HOLO_COLOR = new THREE.Color(0x4fd6ff);
const LISTEN_COLOR = new THREE.Color(0x5cff9d);
const HIGHLIGHT_COLOR = 0x2a9dff;

const VIEWS = {
  body: { target: [0, 0.85, 0], position: [0, 1.0, 4.4] },
  upper: { target: [0, 1.3, 0], position: [0.25, 1.4, 1.9] },
  head: { target: [0, 1.49, 0.03], position: [0.18, 1.53, 0.72] },
  front: { target: [0, 0.85, 0], position: [0, 0.85, 4.4] },
  back: { target: [0, 0.85, 0], position: [0, 0.85, -4.4] },
  left: { target: [0, 0.85, 0], position: [4.4, 0.85, 0] }, // the model's left side
  right: { target: [0, 0.85, 0], position: [-4.4, 0.85, 0] },
  top: { target: [0, 0.85, 0], position: [0, 5.2, 0.01] },
};

/** "left_lower_first_secondary_molar_tooth__FMA55704" -> "Left lower first secondary molar tooth" */
export function prettyPartName(name) {
  const clean = name.replace(/__.*$/, "").replace(/_?schematic$/i, "").replace(/_/g, " ").trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function hologramMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: HOLO_COLOR.clone() },
      uIntensity: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        #include <clipping_planes_fragment>
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.5);
        float scan = 0.85 + 0.15 * sin(gl_FragCoord.y * 0.7 - uTime * 4.0);
        float alpha = (0.03 + fresnel * 0.85) * uIntensity * scan;
        gl_FragColor = vec4(uColor * (0.5 + fresnel), alpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
  });
}

function glowSprite() {
  const size = 128;
  const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(120,220,255,0.8)");
  g.addColorStop(1, "rgba(80,200,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    opacity: 0,
  });
  return new THREE.Sprite(material);
}

export class Avatar {
  constructor(container, { onSelect, onHover } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;

    this.parts = []; // { id, name, category, mesh }
    this.layers = new Map(); // category -> { meshes, materials:Set, visible, opacity }
    this.hidden = new Set(); // meshes hidden individually (hide / isolate)
    this.selected = null;

    this.skinMode = "hologram";
    this.wireframe = false;
    this.hoverEnabled = false;
    this.section = { enabled: false, axis: "y", position: 0.5, flip: false };
    this.explode = 0;

    // Mouth / voice reactivity
    this.mouth = 0; // smoothed 0..1 opening
    this.manualMouth = 0; // 0..1, used when not speaking
    this.sensitivity = 7;
    this.maxJawOpen = THREE.MathUtils.degToRad(11);
    this.micLevel = 0;
    this.speaking = null; // null | "audio" | "procedural"

    this.clock = new THREE.Clock();
    this.fps = 0;
    this.frames = 0;
    this.fpsTime = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 9;
    this.controls.autoRotateSpeed = 1.5;
    this.controls.addEventListener("start", () => (this.viewTarget = null));

    this.scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x1a1f2b, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1.5, 3, 2.5);
    const rim = new THREE.DirectionalLight(0x6fd3ff, 1.6);
    rim.position.set(-2, 2, -2.5);
    this.scene.add(key, rim);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.#setView("upper", true);
    this.#bindPointer();
    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  /** Load the model; resolves to [{ category, count }] sorted by category. */
  async load(url, onProgress) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    this.model = gltf.scene;
    this.scene.add(this.model);
    this.model.updateMatrixWorld(true);
    this.bodyBox = new THREE.Box3().setFromObject(this.model);

    const jawMeshes = [];
    this.model.traverse((obj) => {
      if (!obj.isMesh) return;
      const category = (obj.material.name || "other").split(":")[0];
      if (!this.layers.has(category)) {
        this.layers.set(category, { meshes: [], materials: new Set(), visible: true, opacity: 1 });
      }
      const layer = this.layers.get(category);
      layer.meshes.push(obj);
      layer.materials.add(obj.material);
      obj.userData.category = category;
      obj.userData.baseMaterial = obj.material;
      this.parts.push({ id: this.parts.length, name: prettyPartName(obj.name), category, mesh: obj });
      obj.userData.partId = this.parts.length - 1;

      if (category === "skin" && /^skin__/i.test(obj.name)) this.skin = obj;
      if (JAW_PARTS.test(obj.name)) jawMeshes.push(obj);
      if (/vocal_fold/i.test(obj.name)) this.larynx ??= obj;
    });
    this.parts.sort((a, b) => a.name.localeCompare(b.name));

    if (this.skin) {
      this.holoMaterial = hologramMaterial();
      this.setSkinMode("hologram");
    }
    this.#buildJaw(jawMeshes);
    this.#buildLarynxGlow();
    this.#prepareExplode();

    // The anatomy is static; skip per-frame local matrix recomputation for ~1,200 nodes.
    this.model.traverse((obj) => {
      if (obj !== this.jawPivot) {
        obj.updateMatrix();
        obj.matrixAutoUpdate = false;
      }
    });
    return [...this.layers.entries()]
      .map(([category, layer]) => ({ category, count: layer.meshes.length }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  // ---------------------------------------------------------------- camera

  setView(name) {
    this.#setView(name, false);
  }

  resetView() {
    this.controls.autoRotate = false;
    this.#setView("upper", false);
  }

  /** factor < 1 zooms in, > 1 zooms out. */
  zoom(factor) {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.viewTarget = { target, position: target.clone().add(offset.setLength(distance)) };
  }

  setAutoRotate(on, speed = this.controls.autoRotateSpeed) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = speed;
  }

  get autoRotate() {
    return this.controls.autoRotate;
  }

  setFov(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setExposure(value) {
    this.renderer.toneMappingExposure = value;
  }

  // ---------------------------------------------------------------- display

  /** "hologram" (translucent glowing shell), "solid" (original skin) or "hidden". */
  setSkinMode(mode) {
    if (!this.skin) return;
    if (this.selected === this.skin) this.#select(null);
    this.skinMode = mode;
    const holo = mode === "hologram";
    this.skin.material = holo ? this.holoMaterial : this.skin.userData.baseMaterial;
    this.skin.renderOrder = holo ? 10 : 0;
    this.skin.userData.noPick = holo;
    this.#applyVisibility(this.skin);
  }

  setSkinColor(hex) {
    HOLO_COLOR.set(hex);
  }

  setSkinIntensity(value) {
    this.skinIntensity = value;
  }

  setWireframe(on) {
    this.wireframe = on;
    for (const layer of this.layers.values()) layer.materials.forEach((m) => (m.wireframe = on));
    if (this.selected) this.selected.material.wireframe = on;
  }

  setHoverLabels(on) {
    this.hoverEnabled = on;
    if (!on) this.onHover?.(null);
  }

  // ---------------------------------------------------------------- layers

  setLayerVisible(category, visible) {
    const layer = this.layers.get(category);
    if (!layer) return;
    layer.visible = visible;
    layer.meshes.forEach((m) => this.#applyVisibility(m));
  }

  layerVisible(category) {
    return this.layers.get(category)?.visible ?? false;
  }

  setLayerOpacity(category, opacity) {
    const layer = this.layers.get(category);
    if (!layer) return;
    layer.opacity = opacity;
    layer.materials.forEach((m) => this.#applyOpacity(m, opacity));
    if (this.selected?.userData.category === category) this.#applyOpacity(this.selected.material, opacity);
  }

  // ---------------------------------------------------------------- parts

  /** [{ id, name, category }] sorted by name. */
  getParts() {
    return this.parts.map(({ id, name, category }) => ({ id, name, category }));
  }

  searchParts(query, limit = 60) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.parts
      .filter((p) => p.name.toLowerCase().includes(q) || p.category.includes(q))
      .slice(0, limit)
      .map(({ id, name, category }) => ({ id, name, category, hidden: this.hidden.has(this.#mesh(id)) }));
  }

  selectPart(id, { focus = false } = {}) {
    const mesh = this.#mesh(id);
    if (!mesh) return;
    // A searched part may be in a hidden layer or individually hidden; reveal it.
    this.hidden.delete(mesh);
    if (!this.layers.get(mesh.userData.category).visible) this.setLayerVisible(mesh.userData.category, true);
    this.#applyVisibility(mesh);
    this.#select(mesh);
    if (focus) this.focusSelected();
  }

  clearSelection() {
    this.#select(null);
  }

  focusSelected() {
    if (!this.selected) return;
    this.#focusObject(this.selected);
  }

  hideSelected() {
    if (!this.selected) return;
    const mesh = this.selected;
    this.#select(null);
    this.hidden.add(mesh);
    this.#applyVisibility(mesh);
  }

  /** Hide every part except the selected one. */
  isolateSelected() {
    if (!this.selected) return;
    for (const { mesh } of this.parts) {
      if (mesh === this.selected) this.hidden.delete(mesh);
      else this.hidden.add(mesh);
      this.#applyVisibility(mesh);
    }
    this.focusSelected();
  }

  /** Bring back parts hidden with hide / isolate (layer toggles are kept). */
  showAllParts() {
    const meshes = [...this.hidden];
    this.hidden.clear();
    meshes.forEach((m) => this.#applyVisibility(m));
  }

  get hiddenCount() {
    return this.hidden.size;
  }

  // ---------------------------------------------------------------- cross-section & explode

  /** axis: "x" | "y" | "z"; position: 0..1 across the body; flip keeps the other side. */
  setSection({ enabled = this.section.enabled, axis = this.section.axis, position = this.section.position, flip = this.section.flip } = {}) {
    this.section = { enabled, axis, position, flip };
    if (!enabled || !this.bodyBox) {
      this.renderer.clippingPlanes = [];
      return;
    }
    const value = THREE.MathUtils.lerp(this.bodyBox.min[axis], this.bodyBox.max[axis], position);
    const normal = new THREE.Vector3();
    normal[axis] = flip ? 1 : -1;
    // Three.js keeps points where normal·p + constant >= 0.
    this.clipPlane.set(normal, flip ? -value : value);
    this.renderer.clippingPlanes = [this.clipPlane];
  }

  /** 0 = assembled, 1 = fully exploded (parts pushed out from the body centre). */
  setExplode(amount) {
    this.explode = amount;
    for (const { mesh } of this.parts) {
      mesh.position.copy(mesh.userData.basePosition).addScaledVector(mesh.userData.explodeDir, amount);
      mesh.updateMatrix();
    }
  }

  // ---------------------------------------------------------------- mouth / voice

  /** Route an <audio> element through an analyser so the jaw follows real speech loudness.
   *  Must be called from a user gesture (browsers block audio contexts otherwise). */
  connectAudio(audioEl) {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.audioCtx.destination);
      this.samples = new Uint8Array(this.analyser.fftSize);
    }
    if (audioEl && !audioEl.__avatarSource) {
      audioEl.__avatarSource = this.audioCtx.createMediaElementSource(audioEl);
      audioEl.__avatarSource.connect(this.analyser);
    }
    return this.audioCtx.resume();
  }

  /** mode: "audio" (driven by connected audio), "procedural" (rhythm), or null. */
  setSpeaking(mode) {
    this.speaking = mode;
  }

  setListeningLevel(level) {
    this.micLevel = level;
  }

  setMouthSettings({ sensitivity, maxOpenDegrees, manual } = {}) {
    if (sensitivity !== undefined) this.sensitivity = sensitivity;
    if (maxOpenDegrees !== undefined) this.maxJawOpen = THREE.MathUtils.degToRad(maxOpenDegrees);
    if (manual !== undefined) this.manualMouth = manual;
  }

  // ---------------------------------------------------------------- tools

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  stats() {
    let visible = 0;
    for (const { mesh } of this.parts) if (mesh.visible) visible++;
    return { parts: this.parts.length, visible, hidden: this.hidden.size, fps: this.fps };
  }

  // ---------------------------------------------------------------- internals

  #mesh(id) {
    return this.parts.find((p) => p.id === id)?.mesh;
  }

  #applyVisibility(mesh) {
    const layerVisible = this.layers.get(mesh.userData.category)?.visible ?? true;
    const skinHidden = mesh === this.skin && this.skinMode === "hidden";
    mesh.visible = layerVisible && !this.hidden.has(mesh) && !skinHidden;
  }

  #applyOpacity(material, opacity) {
    const translucent = opacity < 1;
    material.opacity = opacity;
    material.transparent = translucent;
    material.depthWrite = !translucent;
    material.needsUpdate = true;
  }

  #buildJaw(meshes) {
    const mandible = meshes.find((m) => /^mandible/i.test(m.name));
    if (!mandible) return;
    // Hinge at the temporomandibular joint: top-back of the mandible.
    const box = new THREE.Box3().setFromObject(mandible);
    const size = box.getSize(new THREE.Vector3());
    this.jawPivot = new THREE.Group();
    this.jawPivot.name = "jaw_pivot";
    this.jawPivot.position.set((box.min.x + box.max.x) / 2, box.max.y - size.y * 0.18, box.min.z + size.z * 0.11);
    this.model.add(this.jawPivot);
    this.jawPivot.updateMatrixWorld(true);
    meshes.forEach((m) => this.jawPivot.attach(m));
  }

  #buildLarynxGlow() {
    this.glow = glowSprite();
    this.glow.scale.setScalar(0.06);
    this.glow.renderOrder = 20;
    if (this.larynx) new THREE.Box3().setFromObject(this.larynx).getCenter(this.glow.position).setX(0);
    else this.glow.position.set(0, 1.42, 0.015);
    this.scene.add(this.glow);
  }

  #prepareExplode() {
    const center = this.bodyBox.getCenter(new THREE.Vector3());
    const box = new THREE.Box3();
    const toLocal = new THREE.Matrix3();
    this.model.updateMatrixWorld(true);
    for (const { mesh } of this.parts) {
      const worldDir = box.setFromObject(mesh).getCenter(new THREE.Vector3()).sub(center);
      // Express the world-space push in the parent's frame (rotation + scale, no translation).
      toLocal.setFromMatrix4(mesh.parent.matrixWorld.clone().invert());
      mesh.userData.explodeDir = worldDir.applyMatrix3(toLocal);
      mesh.userData.basePosition = mesh.position.clone();
    }
  }

  #speechLevel(t) {
    if (this.speaking === "audio" && this.analyser) {
      this.analyser.getByteTimeDomainData(this.samples);
      let sum = 0;
      for (const v of this.samples) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / this.samples.length) * this.sensitivity);
    }
    if (this.speaking === "procedural") {
      // Syllable-rate (~5 Hz) open/close with phrase-level variation.
      const syllable = Math.max(0, Math.sin(t * 31));
      const phrase = 0.55 + 0.45 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1);
      return syllable * phrase;
    }
    return 0;
  }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    this.frames++;
    if (t - this.fpsTime >= 1) {
      this.fps = Math.round(this.frames / (t - this.fpsTime));
      this.frames = 0;
      this.fpsTime = t;
    }

    const level = Math.max(this.#speechLevel(t), this.manualMouth);
    // Fast attack, slower release, like a real jaw.
    const k = level > this.mouth ? 0.55 : 0.18;
    this.mouth += (level - this.mouth) * k;
    if (this.jawPivot) this.jawPivot.rotation.x = this.mouth * this.maxJawOpen;

    if (this.glow) {
      const voice = this.speaking ? this.mouth : 0;
      this.glow.material.opacity = Math.min(1, voice * 1.6);
      this.glow.scale.setScalar(0.04 + voice * 0.05);
    }
    if (this.skin && this.skinMode === "hologram") {
      const u = this.holoMaterial.uniforms;
      u.uTime.value = t;
      u.uColor.value.copy(HOLO_COLOR).lerp(LISTEN_COLOR, Math.min(1, this.micLevel * 2.5));
      u.uIntensity.value = (this.skinIntensity ?? 1) * (1 + this.mouth * 0.6 + this.micLevel * 0.8);
    }

    if (this.viewTarget) {
      const a = 1 - Math.exp(-dt * 4);
      this.camera.position.lerp(this.viewTarget.position, a);
      this.controls.target.lerp(this.viewTarget.target, a);
      if (this.camera.position.distanceTo(this.viewTarget.position) < 0.002) this.viewTarget = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  #setView(name, immediate) {
    const v = VIEWS[name];
    if (!v) return;
    const target = { position: new THREE.Vector3(...v.position), target: new THREE.Vector3(...v.target) };
    if (immediate) {
      this.camera.position.copy(target.position);
      this.controls.target.copy(target.target);
      this.viewTarget = null;
    } else {
      this.viewTarget = target;
    }
  }

  #focusObject(object) {
    const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(sphere.radius / Math.sin(fov / 2), 0.2) * 1.15;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.viewTarget = { target: sphere.center.clone(), position: sphere.center.clone().addScaledVector(dir, distance) };
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #pick(event) {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster ??= new THREE.Raycaster();
    this.raycaster.setFromCamera(ndc, this.camera);
    const candidates = this.parts.map((p) => p.mesh).filter((m) => m.visible && !m.userData.noPick);
    const clipping = this.section.enabled;
    const hit = this.raycaster
      .intersectObjects(candidates, false)
      // Ignore geometry removed by the cross-section.
      .find((h) => !clipping || this.clipPlane.distanceToPoint(h.point) >= 0);
    return hit?.object ?? null;
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    let lastHover = 0;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      // Treat as a click only if the pointer barely moved (otherwise it was an orbit drag).
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.#select(this.#pick(e));
    });
    el.addEventListener("dblclick", (e) => {
      const mesh = this.#pick(e);
      if (mesh) {
        this.#select(mesh);
        this.focusSelected();
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.hoverEnabled || e.buttons || performance.now() - lastHover < 100) return;
      lastHover = performance.now();
      const mesh = this.#pick(e);
      const rect = el.getBoundingClientRect();
      this.onHover?.(mesh ? prettyPartName(mesh.name) : null, e.clientX - rect.left, e.clientY - rect.top);
    });
    el.addEventListener("pointerleave", () => this.onHover?.(null));
  }

  #select(mesh) {
    if (this.selected) {
      this.selected.material.dispose();
      this.selected.material = this.selected === this.skin && this.skinMode === "hologram" ? this.holoMaterial : this.selected.userData.baseMaterial;
      this.selected = null;
    }
    if (mesh) {
      // Materials are shared across hundreds of parts; highlight with a private clone.
      const highlight = mesh.userData.baseMaterial.clone();
      highlight.emissive?.set(HIGHLIGHT_COLOR);
      if ("emissiveIntensity" in highlight) highlight.emissiveIntensity = 0.9;
      mesh.material = highlight;
      this.selected = mesh;
    }
    const part = mesh ? this.parts.find((p) => p.mesh === mesh) : null;
    this.onSelect?.(part ? { id: part.id, name: part.name, category: part.category } : null);
  }
}
