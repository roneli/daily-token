// The Blueprint: picking a part shows its panel. The panels are rendered; this only switches between them.
(() => {
  const map = document.getElementById("map");
  if (!map) return;
  const comps = [...map.querySelectorAll(".comp")];
  const views = [...document.querySelectorAll(".bp-view")];
  const sheet = document.getElementById("bp-detail");
  const inner = sheet.querySelector(".inner");
  const scrim = document.querySelector(".bp-scrim");
  // On phones the panel is a sheet: picking a part also opens it.
  const phone = matchMedia("(max-width: 700px)");
  const openSheet = (open) => { sheet.classList.toggle("open", open); scrim.hidden = !open; };
  const pick = (id) => { select(id); if (phone.matches) openSheet(true); };
  function select(id) {
    if (!views.some((v) => v.dataset.view === id)) return;
    for (const c of comps) {
      const on = c.dataset.part === id;
      c.classList.toggle("sel", on);
      // A lit part glows until it has been opened once.
      if (on) c.classList.remove("nudge");
      if (c.classList.contains("lit")) c.setAttribute("aria-pressed", String(on));
    }
    for (const v of views) v.hidden = v.dataset.view !== id;
    inner.scrollTop = 0;
  }

  const start = views.find((v) => !v.hidden)?.dataset.view;
  for (const c of comps) {
    if (c.dataset.part === start) {
      c.classList.add("sel");
      c.setAttribute("aria-pressed", "true");
    } else if (c.classList.contains("lit")) c.classList.add("nudge");
  }

  map.addEventListener("click", (e) => {
    const c = e.target.closest(".comp.lit");
    if (c) pick(c.dataset.part);
  });
  map.addEventListener("keydown", (e) => {
    const c = e.target.closest(".comp.lit");
    if (c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      pick(c.dataset.part);
    }
  });
  inner.addEventListener("click", (e) => {
    const b = e.target.closest("[data-part]");
    if (b) select(b.dataset.part);
    if (e.target.closest("[data-digest]")) openSheet(false);
  });
  document.getElementById("page-blueprint").addEventListener("click", (e) => { if (e.target.closest("[data-sheet=close]")) openSheet(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openSheet(false); });
  // Phones: the changed parts as cards under the map, and the map full screen to move around.
  const panel = map.closest(".bp-map");
  document.querySelector(".bp-cards")?.addEventListener("click", (e) => {
    const c = e.target.closest("[data-open-part]");
    if (c) pick(c.dataset.openPart);
  });
  let zoom = 2;
  const setZoom = (z) => {
    zoom = Math.max(1, Math.min(6, z));
    map.style.width = `${zoom * 100}%`;
  };
  // Full screen opens on the first part that changed.
  const fullScreen = (on) => {
    panel.classList.toggle("zoomed", on);
    document.documentElement.classList.toggle("bp-zoomed", on);
    if (!on) {
      map.style.width = "";
      return;
    }
    // Three times the small map: its words read easily; pinching takes it further, up and down as well as sideways.
    setZoom(3);
    const first = map.querySelector(".comp.sel, .comp.lit");
    requestAnimationFrame(() => {
      if (!first) return;
      const r = first.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      panel.scrollLeft += r.left + r.width / 2 - (p.left + p.width / 2);
      panel.scrollTop += r.top + r.height / 2 - (p.top + p.height / 2);
    });
  };
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bp]");
    if (!b) return;
    if (b.dataset.bp === "zoom") fullScreen(true);
    else fullScreen(false);
  });
  // Two fingers zoom around the point between them, as on any map; one finger moves it.
  let pinch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  panel.addEventListener("touchstart", (e) => {
    if (!panel.classList.contains("zoomed") || e.touches.length !== 2) return;
    const box = panel.getBoundingClientRect();
    const fx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left;
    const fy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top;
    pinch = { d: spread(e.touches), z: zoom, fx, fy, x: panel.scrollLeft + fx, y: panel.scrollTop + fy };
  }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setZoom(pinch.z * (spread(e.touches) / pinch.d));
    const k = zoom / pinch.z;
    panel.scrollLeft = pinch.x * k - pinch.fx;
    panel.scrollTop = pinch.y * k - pinch.fy;
  }, { passive: false });
  panel.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("zoomed") && !sheet.classList.contains("open")) fullScreen(false); });
  // A part pill on a Digest card opens the Blueprint, then asks for its part.
  document.addEventListener("daily:part", (e) => pick(e.detail));
})();
