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
  // A part pill on a Digest card opens the Blueprint, then asks for its part.
  document.addEventListener("daily:part", (e) => pick(e.detail));
})();
