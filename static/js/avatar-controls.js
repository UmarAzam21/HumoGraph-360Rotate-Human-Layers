// Wires the HTML control panel to the Avatar (static/js/avatar.js).
const $ = (id) => document.getElementById(id);

const MODEL_URL = "/static/models/human.glb";
// Layers hidden on load so the jaw, teeth and organs are visible through the hologram skin.
const HIDDEN_BY_DEFAULT = new Set(["muscle", "tendon", "cartilage"]);
const VIEW_KEYS = ["front", "back", "left", "right", "top", "body", "upper", "head"];

export function setAvatarState(state) {
  const badge = $("avatar-state");
  badge.textContent = { idle: "Idle", listening: "Listening", speaking: "Speaking" }[state];
  badge.className = `avatar-state ${state}`;
}

/** Bind a range input to an output element and a setter. */
function bindRange(id, outputId, format, onInput) {
  const input = $(id);
  const update = () => {
    const value = Number(input.value);
    $(outputId).textContent = format(value);
    onInput(value);
  };
  input.addEventListener("input", update);
  update();
  return input;
}

/**
 * Create the avatar, load the model and wire every control.
 * Resolves to the Avatar, or null if WebGL / the model is unavailable (voice features keep working).
 * @param {{ speak: (text: string) => void }} deps
 */
export async function setupAvatar({ speak }) {
  let avatar;
  let selectedPart = null;
  try {
    const { Avatar } = await import("./avatar.js");
    avatar = new Avatar($("avatar"), {
      onSelect: (part) => {
        selectedPart = part;
        $("avatar-label").hidden = !part;
        $("avatar-label-text").textContent = part?.name ?? "";
        $("avatar-label-category").textContent = part?.category ?? "";
      },
      onHover: (name, x, y) => {
        const tip = $("avatar-tooltip");
        tip.hidden = !name;
        if (name) {
          tip.textContent = name;
          tip.style.left = `${x}px`;
          tip.style.top = `${y}px`;
        }
      },
    });
    const layers = await avatar.load(MODEL_URL, (p) => {
      $("avatar-progress").style.width = `${Math.round(p * 100)}%`;
      $("avatar-loading-text").textContent = `Loading 3D human… ${Math.round(p * 100)}%`;
    });
    $("avatar-loading").hidden = true;
    bindLayers(avatar, layers);
  } catch (err) {
    console.error(err);
    $("avatar-loading-text").textContent = `3D model unavailable: ${err.message}`;
    return null;
  }

  const viewActions = bindView(avatar);
  bindSkin(avatar);
  const partActions = bindParts(avatar, () => selectedPart, speak);
  bindSection(avatar);
  bindMouth(avatar);
  bindShortcuts(avatar, viewActions, partActions);

  const refreshStats = () => {
    const s = avatar.stats();
    $("avatar-stats").textContent = `${s.visible} / ${s.parts} parts visible · ${s.hidden} hidden · ${s.fps} fps`;
    $("parts-show-hidden").disabled = s.hidden === 0;
    $("parts-show-hidden").textContent = s.hidden ? `Show hidden parts (${s.hidden})` : "Show hidden parts";
  };
  setInterval(refreshStats, 500);
  refreshStats();
  return avatar;
}

/* ---------------- View ---------------- */
function bindView(avatar) {
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => avatar.setView(btn.dataset.view)),
  );

  const autoRotate = $("ctl-auto-rotate");
  const rotateButton = document.querySelector('[data-action="auto-rotate"]');
  const setAutoRotate = (on) => {
    avatar.setAutoRotate(on, Number($("ctl-rotate-speed").value));
    autoRotate.checked = on;
    rotateButton.setAttribute("aria-pressed", String(on));
  };
  autoRotate.addEventListener("change", () => setAutoRotate(autoRotate.checked));

  const actions = {
    "zoom-in": () => avatar.zoom(0.8),
    "zoom-out": () => avatar.zoom(1.25),
    reset: () => {
      avatar.resetView();
      setAutoRotate(false);
    },
    "auto-rotate": () => setAutoRotate(!avatar.autoRotate),
    fullscreen: () => toggleFullscreen(),
    screenshot: () => downloadScreenshot(avatar),
  };
  document.querySelectorAll("[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => actions[btn.dataset.action]()),
  );

  bindRange("ctl-fov", "fov-out", (v) => `${v}°`, (v) => avatar.setFov(v));
  bindRange("ctl-exposure", "exposure-out", (v) => v.toFixed(1), (v) => avatar.setExposure(v));
  bindRange("ctl-rotate-speed", "rotate-speed-out", (v) => v.toFixed(1), (v) => avatar.setAutoRotate(avatar.autoRotate, v));
  $("ctl-wireframe").addEventListener("change", (e) => avatar.setWireframe(e.target.checked));
  $("ctl-hover").addEventListener("change", (e) => avatar.setHoverLabels(e.target.checked));
  return actions;
}

function toggleFullscreen() {
  const el = $("avatar");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
}

function downloadScreenshot(avatar) {
  const link = document.createElement("a");
  link.href = avatar.screenshot();
  link.download = `humograph-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  link.click();
}

/* ---------------- Skin ---------------- */
function bindSkin(avatar) {
  const color = $("ctl-skin-color");
  const intensity = $("ctl-skin-intensity");
  const mode = $("ctl-skin-mode");
  const syncEnabled = () => {
    // Color and glow only apply to the hologram shader.
    color.disabled = intensity.disabled = mode.value !== "hologram";
  };
  mode.addEventListener("change", () => {
    avatar.setSkinMode(mode.value);
    syncEnabled();
  });
  color.addEventListener("input", () => avatar.setSkinColor(color.value));
  bindRange("ctl-skin-intensity", "skin-intensity-out", (v) => v.toFixed(1), (v) => avatar.setSkinIntensity(v));
  syncEnabled();
}

/* ---------------- Layers ---------------- */
function bindLayers(avatar, layers) {
  const rows = new Map(); // category -> { checkbox, slider }

  const setVisible = (category, visible) => {
    avatar.setLayerVisible(category, visible);
    rows.get(category).checkbox.checked = visible;
  };
  const setOpacity = (category, opacity) => {
    avatar.setLayerOpacity(category, opacity);
    rows.get(category).slider.value = String(opacity);
  };
  const applyDefaults = () =>
    layers.forEach(({ category }) => {
      setVisible(category, !HIDDEN_BY_DEFAULT.has(category));
      setOpacity(category, 1);
    });

  $("layers").replaceChildren(
    ...layers.map(({ category, count }) => {
      const row = document.createElement("div");
      row.className = "layer-row";

      const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
      checkbox.addEventListener("change", () => setVisible(category, checkbox.checked));
      const label = document.createElement("label");
      const countEl = Object.assign(document.createElement("span"), { className: "count", textContent: `(${count})` });
      label.append(checkbox, category, countEl);

      const slider = Object.assign(document.createElement("input"), {
        type: "range", min: "0.05", max: "1", step: "0.05", value: "1", title: `${category} opacity`,
      });
      slider.setAttribute("aria-label", `${category} opacity`);
      slider.addEventListener("input", () => avatar.setLayerOpacity(category, Number(slider.value)));

      const solo = Object.assign(document.createElement("button"), { textContent: "Solo", title: `Show only ${category}` });
      solo.addEventListener("click", () => layers.forEach((l) => setVisible(l.category, l.category === category)));

      row.append(label, slider, solo);
      rows.set(category, { checkbox, slider });
      return row;
    }),
  );

  $("layers-show-all").addEventListener("click", () => layers.forEach(({ category }) => setVisible(category, true)));
  $("layers-hide-all").addEventListener("click", () => layers.forEach(({ category }) => setVisible(category, false)));
  $("layers-reset").addEventListener("click", applyDefaults);
  applyDefaults();
}

/* ---------------- Parts ---------------- */
function bindParts(avatar, getSelected, speak) {
  const search = $("part-search");
  const results = $("part-results");

  const render = () => {
    const query = search.value;
    if (!query.trim()) return results.replaceChildren();
    const matches = avatar.searchParts(query);
    if (!matches.length) {
      results.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "No parts found." }));
      return;
    }
    results.replaceChildren(
      ...matches.map((part) => {
        const li = document.createElement("li");
        li.tabIndex = 0;
        const name = Object.assign(document.createElement("span"), { textContent: part.hidden ? `${part.name} (hidden)` : part.name });
        const cat = Object.assign(document.createElement("span"), { className: "cat", textContent: part.category });
        li.append(name, cat);
        const choose = () => avatar.selectPart(part.id, { focus: true });
        li.addEventListener("click", choose);
        li.addEventListener("keydown", (e) => e.key === "Enter" && choose());
        return li;
      }),
    );
  };
  search.addEventListener("input", render);

  const partActions = {
    focus: () => avatar.focusSelected(),
    hide: () => {
      avatar.hideSelected();
      render();
    },
    isolate: () => avatar.isolateSelected(),
    speak: () => getSelected() && speak(getSelected().name),
    clear: () => avatar.clearSelection(),
  };
  document.querySelectorAll("[data-part-action]").forEach((btn) =>
    btn.addEventListener("click", () => partActions[btn.dataset.partAction]()),
  );

  $("parts-show-hidden").addEventListener("click", () => {
    avatar.showAllParts();
    render();
  });
  $("parts-clear").addEventListener("click", () => avatar.clearSelection());
  return partActions;
}

/* ---------------- Cross-section & explode ---------------- */
function bindSection(avatar) {
  const enabled = $("ctl-section");
  const flip = $("ctl-section-flip");
  const axis = $("ctl-section-axis");
  const apply = () =>
    avatar.setSection({
      enabled: enabled.checked,
      axis: axis.value,
      position: Number($("ctl-section-pos").value),
      flip: flip.checked,
    });
  [enabled, flip, axis].forEach((el) => el.addEventListener("change", apply));
  bindRange("ctl-section-pos", "section-out", (v) => `${Math.round(v * 100)}%`, apply);

  bindRange("ctl-explode", "explode-out", (v) => `${Math.round(v * 100)}%`, (v) => avatar.setExplode(v));
}

/* ---------------- Mouth & voice ---------------- */
function bindMouth(avatar) {
  bindRange("ctl-sensitivity", "sensitivity-out", (v) => String(v), (v) => avatar.setMouthSettings({ sensitivity: v }));
  bindRange("ctl-jaw-max", "jaw-max-out", (v) => `${v}°`, (v) => avatar.setMouthSettings({ maxOpenDegrees: v }));
  bindRange("ctl-jaw-manual", "jaw-manual-out", (v) => `${Math.round(v * 100)}%`, (v) => avatar.setMouthSettings({ manual: v }));

  let timer = null;
  $("ctl-test-talk").addEventListener("click", () => {
    clearTimeout(timer);
    avatar.setSpeaking("procedural");
    setAvatarState("speaking");
    timer = setTimeout(() => {
      avatar.setSpeaking(null);
      setAvatarState("idle");
    }, 3000);
  });
}

/* ---------------- Keyboard shortcuts ---------------- */
function bindShortcuts(avatar, view, part) {
  document.addEventListener("keydown", (e) => {
    // Never steal keys while the user is typing.
    if (e.target.closest("input, textarea, select, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    const handlers = {
      f: () => (e.shiftKey ? view.fullscreen() : part.focus()),
      h: part.hide,
      i: part.isolate,
      a: () => $("parts-show-hidden").click(),
      Escape: part.clear,
      r: view.reset,
      o: view["auto-rotate"],
      p: view.screenshot,
      "+": view["zoom-in"],
      "=": view["zoom-in"],
      "-": view["zoom-out"],
    };
    const index = Number(e.key) - 1;
    if (index >= 0 && index < VIEW_KEYS.length) handlers[e.key] = () => avatar.setView(VIEW_KEYS[index]);

    if (handlers[key]) {
      e.preventDefault();
      handlers[key]();
    }
  });
}
