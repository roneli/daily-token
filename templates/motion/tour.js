// Plays the Cutaway's tracks: seek(ms) puts every element where it is at that moment, so a frame is a pure
// function of time. Nothing here decides anything; tour.layout.ts wrote the keyframes.
(() => {
  const tracks = JSON.parse(document.getElementById("tracks").textContent);
  const alongs = new Map();
  for (const tr of tracks) if (tr.p === "along") alongs.set(tr.el, [...(alongs.get(tr.el) ?? []), tr].sort((a, b) => a.k[0][0] - b.k[0][0]));
  const ease = {
    io: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
    o: (x) => 1 - (1 - x) ** 3,
    l: (x) => x,
  };
  // The value of a list of [t, ...values] keyframes at t: held before the first and after the last.
  function at(k, t, e) {
    if (t <= k[0][0]) return k[0].slice(1);
    const last = k[k.length - 1];
    if (t >= last[0]) return last.slice(1);
    let i = 1;
    while (k[i][0] < t) i++;
    const a = k[i - 1];
    const b = k[i];
    const x = ease[e ?? "io"]((t - a[0]) / (b[0] - a[0] || 1));
    return a.slice(1).map((v, j) => v + (b[j + 1] - v) * x);
  }
  const el = new Map();
  const find = (id) => {
    if (!el.has(id)) el.set(id, document.getElementById(id));
    return el.get(id);
  };
  const W = 1080;
  const H = 1350;
  const center = [540, 590];
  window.setScale = (s) => {
    const stage = document.getElementById("stage");
    stage.style.transform = `scale(${s})`;
    document.body.style.width = `${W * s}px`;
    document.body.style.height = `${H * s}px`;
  };
  window.seek = (t) => {
    const state = new Map();
    const of = (id) => {
      if (!state.has(id)) state.set(id, { o: null, ty: 0, s: 1, moved: false });
      return state.get(id);
    };
    for (const tr of tracks) {
      const node = find(tr.el);
      if (!node) continue;
      if (tr.p === "cam") {
        // Zoom eases in log space, so a long zoom doesn't rush its start.
        const k = tr.k.map(([time, x, y, s]) => [time, x, y, Math.log(s)]);
        const [x, y, ls] = at(k, t, tr.e);
        const s = Math.exp(ls);
        node.setAttribute("transform", `translate(${center[0] - s * x} ${center[1] - s * y}) scale(${s})`);
      } else if (tr.p === "along") {
        // Of an element's paths, the one it is on now: the last to have started, held at its end until the next.
        // Every frame sets it, so where it is never depends on which frame this page drew before.
        const mine = alongs.get(tr.el);
        const now = mine.filter((x) => x.k[0][0] <= t).at(-1) ?? mine[0];
        if (now !== tr) continue;
        const path = find(tr.path);
        const [f] = at(tr.k, t, tr.e);
        const p = path.getPointAtLength(f * path.getTotalLength());
        node.setAttribute("transform", `translate(${p.x} ${p.y})`);
      } else if (tr.p === "dash") {
        node.style.strokeDashoffset = at(tr.k, t, tr.e)[0];
      } else if (tr.p === "pulse") {
        const st = of(tr.el);
        st.moved = true;
        // Whole periods only, so it rests at its own size once it stops.
        if (t >= tr.from && (tr.to === undefined || t <= tr.to)) st.s *= 1 + tr.amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t - tr.from)) / tr.period));
      } else {
        const st = of(tr.el);
        const [v] = at(tr.k, t, tr.e);
        if (tr.p === "o") st.o = st.o === null ? v : st.o * v;
        else {
          st.moved = true;
          if (tr.p === "ty") st.ty += v;
          else st.s *= v;
        }
      }
    }
    for (const [id, st] of state) {
      const node = find(id);
      if (st.o !== null) node.style.opacity = st.o.toFixed(3);
      if (st.moved) node.style.transform = `translateY(${st.ty.toFixed(2)}px) scale(${st.s.toFixed(4)})`;
    }
  };
})();
