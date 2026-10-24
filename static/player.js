// The Daily Token player: tabs, threads of reels, and the data-anim timeline engine.
// A reel's markup is complete at rest; the engine only hides what a mark reveals, then replays time.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(max-width: 700px)");
  const app = document.querySelector(".app");
  // Shown when the last story ends; made further down.
  let endCard = null;
  const book = document.getElementById("book");
  const pages = [...document.querySelectorAll(".reel")];
  const ease = (f) => 1 - (1 - f) ** 3;
  const STATES = ["on", "bad-on", "good-on"];

  const effects = {
    fade: (m, f) => { m.el.style.opacity = f; },
    out: (m, f) => { m.el.style.opacity = 1 - f; },
    drop: (m, f) => { m.el.style.opacity = f; m.el.style.transform = `translateY(${(1 - ease(f)) * -24}px)`; },
    grow: (m, f) => { m.el.style.transform = `scaleY(${ease(f)})`; },
    class: (m) => { m.el.classList.remove(...STATES); if (m.d.to) m.el.classList.add(m.d.to); },
    text: (m) => { m.el.textContent = m.d.to; },
    count: (m, f) => { const a = +m.d.from, b = +m.d.to; m.el.textContent = (m.d.prefix ?? "") + Math.round(a + (b - a) * ease(f)).toLocaleString("en-US") + (m.d.suffix ?? ""); },
    width: (m, f) => { const a = +m.d.from, b = +m.d.to; m.el.setAttribute("width", a + (b - a) * ease(f)); },
    type: (m, f) => { m.el.textContent = m.d.to.slice(0, Math.round(m.d.to.length * f)); },
    // A drawn line's arrowhead waits for the line to reach it.
    draw: (m, f) => { const len = m.el.getTotalLength(); m.el.style.strokeDasharray = len; m.el.style.strokeDashoffset = len * (1 - ease(f)); m.el.style.markerEnd = f < 1 ? "none" : ""; },
    move: (m, f) => { const k = ease(f); m.el.setAttribute("cx", m.from[0] + (m.to[0] - m.from[0]) * k); m.el.setAttribute("cy", m.from[1] + (m.to[1] - m.from[1]) * k); },
  };
  const INSTANT = new Set(["class", "text"]);
  const HIDDEN_AT_START = new Set(["fade", "drop", "grow", "type", "draw"]);

  function timeline(page) {
    const marks = [];
    for (const el of page.querySelectorAll("[data-anim]")) marks.push({ el, kind: el.dataset.anim, d: el.dataset });
    for (const cue of page.querySelectorAll("[data-cue]")) {
      const el = page.querySelector(`#${CSS.escape(cue.dataset.el)}`);
      if (el) marks.push({ el, kind: cue.dataset.cue, d: cue.dataset });
      else console.warn("[daily] cue target missing:", cue.dataset.el);
    }
    for (const m of marks) { m.at = +(m.d.at ?? 0); m.ms = +(m.d.ms ?? 300); }
    marks.sort((a, b) => a.at - b.at);
    const snap = new Map();
    for (const m of marks) if (!snap.has(m.el)) snap.set(m.el, { cls: m.el.getAttribute("class"), text: m.el.textContent, width: m.el.getAttribute("width"), cx: m.el.getAttribute("cx"), cy: m.el.getAttribute("cy") });
    const pos = new Map();
    for (const m of marks) {
      if (m.kind !== "move") continue;
      const s = snap.get(m.el);
      m.from = pos.get(m.el) ?? [+s.cx, +s.cy];
      m.to = [+m.d.x, +m.d.y];
      pos.set(m.el, m.to);
    }
    return { marks, snap, ms: +page.dataset.ms };
  }

  function seek(tl, t) {
    for (const [el, s] of tl.snap) {
      if (s.cls !== null) el.setAttribute("class", s.cls);
      if (s.width !== null) el.setAttribute("width", s.width);
      if (s.cx !== null) { el.setAttribute("cx", s.cx); el.setAttribute("cy", s.cy); }
      if (el.children.length === 0 && el.textContent !== s.text) el.textContent = s.text;
      el.style.opacity = "";
      el.style.transform = "";
      el.style.strokeDasharray = "";
      el.style.strokeDashoffset = "";
      el.style.markerEnd = "";
    }
    for (const m of tl.marks) {
      if (m.at > t) { if (HIDDEN_AT_START.has(m.kind)) effects[m.kind](m, 0); if (m.kind === "count") effects.count(m, 0); continue; }
      effects[m.kind]?.(m, INSTANT.has(m.kind) || m.ms <= 0 ? 1 : Math.min(1, (t - m.at) / m.ms));
    }
  }

  // Threads: a story's shorts, one after another. `cur` counts shorts across the whole issue, so the last short of
  // a thread runs on into the next thread's first.
  const threads = [...document.querySelectorAll(".thread")];
  const threadOf = pages.map((p) => threads.indexOf(p.closest(".thread")));
  const firstOf = threads.map((th) => pages.indexOf(th.querySelector(".reel")));
  const lastOf = threads.map((th, i) => firstOf[i] + th.querySelectorAll(".reel").length - 1);
  const circles = [...document.querySelectorAll(".circle")];
  const tls = pages.map(timeline);
  let cur = 0, t = 0, playing = !reduced, last = performance.now();
  const tNow = () => threadOf[cur];

  // Threads watched to their end keep their circle grey, on this device only.
  const seenKey = `daily-seen:${location.pathname}`;
  const seen = new Set();
  try { for (const id of JSON.parse(localStorage.getItem(seenKey) ?? "[]")) seen.add(id); } catch {}
  const markSeen = (i) => {
    if (seen.has(threads[i].id)) return;
    seen.add(threads[i].id);
    try { localStorage.setItem(seenKey, JSON.stringify([...seen])); } catch {}
  };

  // Desktop stacks the threads either side behind the current one, dimmed; a click there goes to that thread. The
  // next ones out wait unseen, so the stack slides as a whole.
  function place() {
    const k = tNow();
    for (const [i, th] of threads.entries()) {
      th.hidden = Math.abs(i - k) > 2;
      th.classList.toggle("cur", i === k);
      th.classList.toggle("side-prev", i === k - 1);
      th.classList.toggle("side-next", i === k + 1);
      th.classList.toggle("far-prev", i === k - 2);
      th.classList.toggle("far-next", i === k + 2);
      if (i !== k && !th.hidden) {
        // A side thread shows its first short whole.
        for (let p = firstOf[i]; p <= lastOf[i]; p++) pages[p].hidden = p !== firstOf[i];
        seek(tls[firstOf[i]], tls[firstOf[i]].ms);
      }
    }
    for (const [i, c] of circles.entries()) {
      c.classList.toggle("cur", i === k);
      c.classList.toggle("seen", seen.has(threads[i].id) && i !== k);
    }
    circles[k]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  function paint() {
    const k = tNow();
    const bars = threads[k].querySelectorAll(".seg .bar i");
    bars.forEach((b, j) => {
      const i = firstOf[k] + j;
      b.style.width = i < cur ? "100%" : i > cur ? "0" : `${Math.max(0, Math.min(100, (t / tls[cur].ms) * 100))}%`;
    });
  }

  // On a phone a new thread slides in over the one it leaves; on a wide screen the stack moves by itself.
  function swapThread(from, to, back) {
    if (reduced || !phone.matches || !to.animate) return;
    const dir = back ? -1 : 1, ms = 420, curve = "cubic-bezier(.2,.8,.2,1)";
    from.hidden = false;
    from.classList.add("leaving");
    from.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 30}%) scale(.92)`, opacity: 0.2 }], { duration: ms, easing: curve })
      .onfinish = () => { from.classList.remove("leaving"); from.hidden = Math.abs(threads.indexOf(from) - tNow()) > 2; };
    to.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: "none" }], { duration: ms, easing: curve });
  }

  // On a phone a short's words never scroll: they shrink a little, then the PR chips go (the story sheet has them),
  // then they shrink to about three quarters, then the why goes, and what still runs over fades out at the foot.
  function fit(page) {
    const copy = page.querySelector(".copy");
    if (!copy) return;
    copy.classList.remove("lean", "terse", "clipped");
    copy.style.removeProperty("--fit");
    if (!phone.matches || page.hidden) return;
    const over = () => copy.scrollHeight > copy.clientHeight + 1;
    let f = 1;
    const shrink = (least) => {
      while (over() && f > least + 0.001) {
        f -= 0.04;
        copy.style.setProperty("--fit", f.toFixed(2));
      }
    };
    shrink(0.88);
    if (over()) copy.classList.add("lean");
    shrink(0.72);
    if (over()) copy.classList.add("terse");
    if (over()) copy.classList.add("clipped");
  }
  const fitShown = () => { for (const p of pages) if (!p.hidden && p.closest(".thread:not([hidden])")) fit(p); };

  function go(i, still) {
    const next = Math.max(0, Math.min(pages.length - 1, i));
    const prev = pages[cur];
    const from = tNow();
    if (threadOf[next] !== from && next > cur) markSeen(from);
    const moved = next !== cur;
    cur = next;
    if (endCard) endCard.hidden = true;
    dropSheet();
    place();
    pages.forEach((p, k) => { if (threadOf[k] === tNow()) p.hidden = k !== cur; });
    fitShown();
    // Within a story the next short cuts in at once, as stories do; a new story comes in whole.
    if (!still && moved && threadOf[cur] !== from) swapThread(threads[from], threads[tNow()], cur < pages.indexOf(prev));
    // A short plays at once; a new story once its card has come to the front.
    const lead = threadOf[cur] === from ? 0 : phone.matches ? -300 : -500;
    t = playing && moved ? lead : playing ? 0 : tls[cur].ms;
    seek(tls[cur], t);
    paint();
  }
  const goThread = (k) => go(firstOf[Math.max(0, Math.min(threads.length - 1, k))]);

  function setPlaying(p) {
    playing = p;
    app.classList.toggle("paused", !p);
    if (p && endCard) endCard.hidden = true;
    const done = cur === pages.length - 1 && t >= tls[cur].ms;
    document.getElementById("play-label").textContent = p ? "Pause" : done ? "Replay" : "Play";
    document.getElementById("play-icon").setAttribute("d", p ? "M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z" : "M2 1 L11 6 L2 11 Z");
    last = performance.now();
  }

  function frame(now) {
    if (playing && !app.classList.contains("on-page") && !sheetOpen()) {
      t += Math.min(100, now - last);
      seek(tls[cur], t);
      if (t >= tls[cur].ms) {
        if (cur < pages.length - 1) go(cur + 1);
        else { t = tls[cur].ms; markSeen(tNow()); setPlaying(false); threads[tNow()].append(endCard); endCard.hidden = false; }
      }
      paint();
    }
    last = now;
    requestAnimationFrame(frame);
  }

  // The story under the reel: a sheet over it on a phone, beside it on a wide screen.
  // The sheet pauses the reel; closing it plays on only if it was playing when it opened.
  const sheetOpen = () => !threads[tNow()].querySelector(".sheet").hidden;
  let resume = false;
  function openSheet(open) {
    let changed = false;
    for (const [i, th] of threads.entries()) {
      const sheet = th.querySelector(".sheet");
      const show = open && i === tNow();
      if (sheet.hidden === !show) continue;
      sheet.hidden = !show;
      changed = true;
      if (show && !reduced && sheet.animate) sheet.animate([{ transform: "translateY(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    if (!changed) return;
    if (open) { resume = playing; setPlaying(false); }
    else { if (resume) setPlaying(true); resume = false; }
  }
  // A move to another short or tab closes the sheet without playing on.
  const dropSheet = () => { resume = false; openSheet(false); };

  document.getElementById("play").addEventListener("click", () => {
    if (playing) return setPlaying(false);
    if (t >= tls[cur].ms) { setPlaying(true); go(cur === pages.length - 1 ? 0 : cur); return; }
    setPlaying(true);
  });
  // Wide screens: the card steps through its story's shorts; the cards behind it and the space beside the stack
  // move between stories.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-read]")) openSheet(!sheetOpen());
    // A click beside the open sheet closes it, and does nothing else.
    else if (sheetOpen() && !e.target.closest(".sheet")) { e.preventDefault(); e.stopPropagation(); openSheet(false); }
  }, true);
  for (const c of circles) c.addEventListener("click", () => { goThread(+c.dataset.toThread); if (!reduced) setPlaying(true); });
  for (const [i, th] of threads.entries()) th.addEventListener("click", (e) => {
    if (e.target.closest("[data-sheet=close]")) { openSheet(false); return; }
    if (i !== tNow()) { e.preventDefault(); goThread(i); return; }
    // The picture steps on pointerup, for hold-to-pause; the rest of the card does the same on a plain click.
    if (phone.matches || e.target.closest(".viz, a, button, summary, details") || String(getSelection()).trim()) return;
    const r = th.getBoundingClientRect();
    go(e.clientX - r.left < r.width / 3 ? cur - 1 : cur + 1);
  });
  book.addEventListener("click", (e) => {
    if (phone.matches || e.target.closest(".thread")) return;
    const r = threads[tNow()].getBoundingClientRect();
    if (e.clientX < r.left) goThread(tNow() - 1);
    else if (e.clientX > r.right) goThread(tNow() + 1);
  });
  document.addEventListener("keydown", (e) => {
    if (app.classList.contains("on-page") || e.target.closest?.("input, textarea")) return;
    if (e.key === "ArrowRight") e.shiftKey ? goThread(tNow() + 1) : go(cur + 1);
    else if (e.key === "ArrowLeft") e.shiftKey ? goThread(tNow() - 1) : go(cur - 1);
    else if (e.key === "ArrowUp") { e.preventDefault(); openSheet(true); }
    else if (e.key === "ArrowDown" || e.key === "Escape") { if (sheetOpen()) { e.preventDefault(); openSheet(false); } }
    else if (e.key === " " && e.target === document.body) { e.preventDefault(); document.getElementById("play").click(); }
  });

  // Phones: swipe left or right for the next or the previous story, the neighbour following the finger; swipe up
  // for the story in the digest.
  let swipe = null;
  const peekAt = (s, dx) => {
    s.from.style.transform = `translateX(${dx}px)`;
    if (s.peek) s.peek.style.transform = `translateX(${dx + (s.dx < 0 ? s.w : -s.w)}px)`;
  };
  book.addEventListener("touchstart", (e) => {
    if (!phone.matches || app.classList.contains("on-page") || e.touches.length > 1 || sheetOpen()) return;
    const p = e.touches[0];
    swipe = { x: p.clientX, y: p.clientY, at: performance.now(), dx: 0, on: false };
  }, { passive: true });
  book.addEventListener("touchmove", (e) => {
    if (!swipe) return;
    const p = e.touches[0], dx = p.clientX - swipe.x, dy = p.clientY - swipe.y;
    if (!swipe.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // Up opens the story.
        if (dy < -40) { swipe = null; openSheet(true); }
        else if (Math.abs(dy) > 40) swipe = null;
        return;
      }
      if (!e.cancelable) { swipe = null; return; }
      swipe.on = true;
      swipe.from = threads[tNow()];
      swipe.w = book.clientWidth;
      swipe.target = dx < 0 ? tNow() + 1 : tNow() - 1;
      swipe.peek = threads[swipe.target] ?? null;
      if (swipe.peek) {
        swipe.peek.hidden = false;
        swipe.peek.classList.add("peek");
        for (let k = firstOf[swipe.target]; k <= lastOf[swipe.target]; k++) pages[k].hidden = k !== firstOf[swipe.target];
        fit(pages[firstOf[swipe.target]]);
        seek(tls[firstOf[swipe.target]], 0);
      }
      swipe.wasPlaying = playing;
      setPlaying(false);
    }
    e.preventDefault();
    // Past the first or last story the page only gives a little.
    swipe.dx = swipe.peek ? dx : dx * 0.25;
    peekAt(swipe, swipe.dx);
  }, { passive: false });
  const release = () => {
    const s = swipe;
    swipe = null;
    if (!s?.on) return;
    const v = Math.abs(s.dx) / (performance.now() - s.at);
    const commit = s.peek && (Math.abs(s.dx) > s.w * 0.2 || v > 0.5);
    const to = commit ? (s.dx < 0 ? -s.w : s.w) : 0;
    const done = () => {
      s.from.style.transform = "";
      if (s.peek) { s.peek.classList.remove("peek"); s.peek.style.transform = ""; }
      if (commit) {
        if (!reduced) setPlaying(true);
        if (s.target > tNow()) markSeen(tNow());
        go(firstOf[s.target], true);
      } else {
        place();
        setPlaying(s.wasPlaying);
      }
    };
    if (reduced || !s.from.animate) return done();
    const ms = 260, curve = "cubic-bezier(.2,.8,.2,1)";
    const off = s.dx < 0 ? s.w : -s.w;
    s.from.animate([{ transform: `translateX(${s.dx}px)` }, { transform: `translateX(${to}px)` }], { duration: ms, easing: curve });
    peekAt(s, to);
    if (s.peek) s.peek.animate([{ transform: `translateX(${s.dx + off}px)` }, { transform: `translateX(${to + off}px)` }], { duration: ms, easing: curve }).onfinish = done;
    else setTimeout(done, ms);
  };
  book.addEventListener("touchend", release);
  book.addEventListener("touchcancel", release);

  // Phones: drag the open sheet down to put it away, as it came up. Its words scroll first: only a drag that starts
  // with them at the top moves the sheet.
  let drag = null;
  for (const sheet of document.querySelectorAll(".sheet")) {
    sheet.addEventListener("touchstart", (e) => {
      drag = null;
      if (!phone.matches || e.touches.length > 1 || sheet.scrollTop > 0) return;
      const p = e.touches[0], now = performance.now();
      drag = { sheet, x: p.clientX, y: p.clientY, dy: 0, v: 0, at: now, on: false };
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (drag?.sheet !== sheet) return;
      const p = e.touches[0], dx = p.clientX - drag.x, dy = p.clientY - drag.y, now = performance.now();
      if (!drag.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dy <= 0 || Math.abs(dx) > dy || !e.cancelable) { drag = null; return; }
        drag.on = true;
        drag.h = sheet.offsetHeight;
      }
      e.preventDefault();
      const next = Math.max(0, dy);
      if (now > drag.at) drag.v = (next - drag.dy) / (now - drag.at);
      drag.dy = next;
      drag.at = now;
      if (!reduced) sheet.style.transform = `translateY(${next}px)`;
    }, { passive: false });
    const settle = (e) => {
      const d = drag;
      drag = null;
      if (!d?.on) return;
      // Past a quarter of its height, or flicked down, it closes; otherwise it springs back. A finger that stopped
      // before it lifted didn't flick.
      const v = performance.now() - d.at < 100 ? d.v : 0;
      const close = e.type === "touchend" && (d.dy > d.h * 0.25 || (v > 0.5 && d.dy > 24));
      if (reduced || !sheet.animate) { sheet.style.transform = ""; if (close) openSheet(false); return; }
      const curve = "cubic-bezier(.2,.8,.2,1)";
      sheet.style.transform = close ? `translateY(${d.h}px)` : "";
      const a = sheet.animate([{ transform: `translateY(${d.dy}px)` }, { transform: close ? `translateY(${d.h}px)` : "none" }], { duration: close ? 220 : 260, easing: curve });
      if (close) a.onfinish = () => { sheet.style.transform = ""; openSheet(false); };
    };
    sheet.addEventListener("touchend", settle);
    sheet.addEventListener("touchcancel", settle);
  }

  // Tap the left third to go back, elsewhere to go on; hold to pause. On a phone the whole card does it, picture
  // and words, as a story does; on a wide screen the picture, the rest of the card having its own clicks.
  const tappable = (e) => !e.target.closest("a, button, summary, details, .prs") && (phone.matches || e.target.closest(".viz"));
  // A chevron at the edge tapped, so a step back is seen.
  const flash = (th, back) => {
    if (reduced) return;
    const c = document.createElement("span");
    c.className = `tap-flash ${back ? "back" : "next"}`;
    c.textContent = back ? "‹" : "›";
    th.append(c);
    setTimeout(() => c.remove(), 450);
  };
  for (const stage of document.querySelectorAll(".reel .stage")) {
    let hold = null, held = false, wasPlaying = false;
    // A hold the sheet interrupts leaves the play state to the sheet.
    stage.addEventListener("pointerdown", (e) => { if (!tappable(e)) return; held = false; wasPlaying = playing; hold = setTimeout(() => { if (sheetOpen()) return; held = true; setPlaying(false); }, 250); });
    stage.addEventListener("pointercancel", () => { clearTimeout(hold); if (held && wasPlaying && !sheetOpen() && !swipe?.on) setPlaying(true); held = false; });
    stage.addEventListener("pointerup", (e) => {
      clearTimeout(hold);
      const th = stage.closest(".thread");
      if (!tappable(e) || swipe?.on || sheetOpen() || th !== threads[tNow()]) return;
      if (held) { if (wasPlaying) setPlaying(true); return; }
      const r = stage.getBoundingClientRect();
      const back = e.clientX - r.left < r.width / 3;
      if (phone.matches) flash(th, back);
      go(back ? cur - 1 : cur + 1);
    });
  }

  addEventListener("resize", fitShown);
  document.fonts?.ready.then(fitShown);

  // The last story ends on a card, as stories apps say you're up to date: play the issue again, or read the Ledger.
  endCard = document.createElement("div");
  endCard.className = "end-card";
  endCard.hidden = true;
  endCard.innerHTML = `<b>You're up to date</b><span>That's every story in this issue.</span><div><button type="button" data-end="replay">↺ Play again</button><button type="button" data-end="read">Read the ${document.getElementById("tab-digest").textContent.trim()}</button></div>`;
  endCard.addEventListener("click", (e) => {
    const b = e.target.closest("[data-end]");
    if (!b) return;
    e.stopPropagation();
    endCard.hidden = true;
    if (b.dataset.end === "read") return showTab("digest");
    // Playing first, so the first story starts from its beginning, not its end.
    setPlaying(true);
    goThread(0);
  });

  // People who asked their phone for less motion get no autoplay, so a paused reel shows them a play button.
  for (const viz of document.querySelectorAll(".reel .viz")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "resume";
    b.setAttribute("aria-label", "Play");
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
    b.addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("play").click(); });
    viz.append(b);
  }

  app.classList.toggle("paused", !playing);
  app.classList.toggle("reduced", reduced);

  // Phones: a downward drag at the top of the reels would reload the issue (pull-to-refresh), and the reels never
  // scroll, so it is cancelled there. Sideways drags, swiping up and the other tabs keep theirs.
  let pull = null;
  document.addEventListener("touchstart", (e) => { pull = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!pull || !phone.matches || app.classList.contains("on-page") || sheetOpen() || !e.cancelable) return;
    const dx = e.touches[0].clientX - pull.x, dy = e.touches[0].clientY - pull.y;
    if (dy > 0 && dy > Math.abs(dx) && document.scrollingElement.scrollTop <= 0) e.preventDefault();
  }, { passive: false });
  // A clear swipe down opens the Ledger at the story being watched, as a story viewer's swipe down leaves it.
  document.addEventListener("touchend", (e) => {
    const start = pull;
    pull = null;
    if (!start || !phone.matches || app.classList.contains("on-page") || sheetOpen()) return;
    const t = e.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (dy < 70 || dy < Math.abs(dx) * 1.5) return;
    // The week's recap is d-week in the Ledger; every other story has its own id there.
    const id = threads[tNow()].id.replace(/^thread-/, "");
    const story = document.getElementById(`d-${id === "recap" ? "week" : id}`);
    showTab("digest", story?.id);
  });

  // The first reel on a phone shows once where to tap, until the first tap or a few seconds.
  const hintKey = "daily-token:tap-hint";
  let hinted = true;
  try { hinted = localStorage.getItem(hintKey) === "1"; } catch {}
  if (phone.matches && !hinted && threads.length) {
    const hint = document.createElement("div");
    hint.className = "tap-hint";
    hint.setAttribute("aria-hidden", "true");
    hint.innerHTML = '<span class="back"><b>‹ Back</b></span><span class="next"><b>Next ›</b></span>';
    threads[tNow()].append(hint);
    const done = () => { hint.classList.add("gone"); setTimeout(() => hint.remove(), 400); try { localStorage.setItem(hintKey, "1"); } catch {} };
    setTimeout(done, 2600);
    book.addEventListener("pointerdown", done, { once: true });
  }

  // Tabs
  // The line under the headline: the reels' overview; the other tabs say what they are by their name alone.
  const DEKS = { reels: document.getElementById("ph-dek").textContent, digest: "", blueprint: "" };
  // The Cutaway tab, when the issue has a motion: its video plays only when asked.
  const motionPage = document.getElementById("page-motion");
  const video = document.getElementById("motion-video");
  if (motionPage) DEKS.motion = "";
  const PAGES = Object.keys(DEKS).filter((name) => name !== "reels");
  // A tab's address is its name ("#ledger"); its id ("#reels", "#motion"), its older address, still opens it.
  const ADDRESS = Object.fromEntries(Object.keys(DEKS).map((id) => [id, document.getElementById(`tab-${id}`).textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")]));
  const tabAt = (h) => Object.keys(ADDRESS).find((id) => ADDRESS[id] === h) ?? (h in DEKS ? h : undefined);
  // The reels pause while another tab is open, and play on when you come back, if they were playing.
  let resumeReels = false;
  function showTab(which, anchor) {
    const wasReels = !app.classList.contains("on-page");
    if (which !== "reels") {
      if (wasReels) resumeReels = playing;
      dropSheet();
      setPlaying(false);
    }
    if (which !== "motion") video?.pause();
    if (which === "reels" && !wasReels && resumeReels && !reduced) {
      setPlaying(true);
      if (t >= tls[cur].ms) go(cur === pages.length - 1 ? 0 : cur);
    }
    for (const name of Object.keys(DEKS)) document.getElementById(`tab-${name}`).setAttribute("aria-selected", name === which);
    // The phone's section menu names the same tab.
    document.getElementById("section-name").textContent = document.getElementById(`tab-${which}`).textContent;
    for (const b of document.querySelectorAll("#sections [data-tab]")) b.toggleAttribute("aria-current", b.dataset.tab === which);
    for (const name of PAGES) document.getElementById(`page-${name}`).hidden = which !== name;
    app.classList.toggle("on-page", which !== "reels");
    document.getElementById("ph-dek").textContent = DEKS[which];
    const shown = which === "reels" ? book : document.getElementById(`page-${which}`);
    if (!reduced && shown.animate) shown.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    try { history.replaceState(null, "", `#${ADDRESS[which]}`); } catch {}
    requestAnimationFrame(() => { const el = anchor && document.getElementById(anchor); if (el) el.scrollIntoView({ block: "start" }); else scrollTo(0, 0); });
  }
  for (const name of Object.keys(DEKS)) document.getElementById(`tab-${name}`).addEventListener("click", () => showTab(name));

  // Phones: one pill names the tab you are on and opens the others, each with a line on what it is.
  const pill = document.getElementById("section-pill");
  const menu = document.getElementById("sections");
  // It grows out of the pill, its rows following one after another, and shrinks back into it.
  const curve = "cubic-bezier(.2,.8,.2,1)";
  let closing = null;
  const openSections = (open) => {
    pill.setAttribute("aria-expanded", open);
    closing?.cancel();
    closing = null;
    if (open) {
      menu.hidden = false;
      if (reduced || !menu.animate) return;
      menu.animate([{ opacity: 0, transform: "translateY(-6px) scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: curve });
      for (const [i, b] of [...menu.children].entries())
        b.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200, delay: 40 + i * 35, easing: curve, fill: "backwards" });
    } else if (!menu.hidden) {
      if (reduced || !menu.animate) { menu.hidden = true; return; }
      closing = menu.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px) scale(.96)" }], { duration: 140, easing: "ease-in" });
      closing.onfinish = () => { menu.hidden = true; closing = null; };
    }
  };
  pill.addEventListener("click", (e) => { e.stopPropagation(); openSections(menu.hidden); });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    openSections(false);
    showTab(b.dataset.tab);
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest("#sections")) openSections(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { openSections(false); pill.focus(); } });
  // The narration under the video: a line's time plays from there, and the line being shown is marked.
  if (video) {
    const lines = [...motionPage.querySelectorAll(".narration li")];
    video.addEventListener("timeupdate", () => {
      const now = lines.findLast((li) => Number(li.dataset.start) <= video.currentTime + 0.05);
      for (const li of lines) li.toggleAttribute("data-now", li === now && !video.paused);
    });
    video.addEventListener("pause", () => { for (const li of lines) li.removeAttribute("data-now"); });
  }
  document.addEventListener("click", (e) => {
    const seek = e.target.closest("[data-seek]");
    if (seek && video) { video.currentTime = Number(seek.dataset.seek); video.play(); return; }
    const toDigest = e.target.closest("[data-digest]");
    if (toDigest) { e.preventDefault(); showTab("digest", toDigest.dataset.digest); return; }
    const toThread = e.target.closest("[data-thread]");
    if (toThread) { e.preventDefault(); showTab("reels"); setPlaying(true); goThread(threads.findIndex((th) => th.id === `thread-${toThread.dataset.thread}`)); return; }
    const toPart = e.target.closest("[data-part]");
    if (toPart && !toPart.closest("#page-blueprint")) { showTab("blueprint"); document.dispatchEvent(new CustomEvent("daily:part", { detail: toPart.dataset.part })); }
  });

  setPlaying(playing);
  go(0);
  const opened = tabAt(location.hash.slice(1));
  if (opened && opened !== "reels") showTab(opened);
  addEventListener("hashchange", () => { const t = tabAt(location.hash.slice(1)); if (t) showTab(t); });

  // Editions: a drawer on small screens, a rail on wide ones. The list comes from the site's index.json,
  // so an old issue still lists the editions published after it.
  const drawer = document.getElementById("editions");
  const scrim = document.querySelector(".ed-scrim");
  const openEditions = (open) => { drawer.classList.toggle("open", open); scrim.hidden = !open; };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-editions]"); if (b) openEditions(b.dataset.editions === "open"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openEditions(false); });
  const list = document.getElementById("ed-list");
  const current = list.dataset.current;
  const fmt = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
  const weekOf = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 2) % 7)); return t.toISOString().slice(0, 10); };
  const item = (e) => {
    const a = document.createElement("a");
    a.className = "ed-item";
    a.href = `../${e.date}/`;
    if (e.date === current) a.setAttribute("aria-current", "page");
    const date = document.createElement("span"); date.className = "ed-date"; date.textContent = fmt(e.date, { weekday: "short", day: "numeric", month: "short" });
    const title = document.createElement("span"); title.className = "ed-title"; title.textContent = e.headline;
    a.append(date, title);
    return a;
  };
  const group = (text) => { const p = document.createElement("p"); p.className = "ed-group"; p.textContent = text; return p; };
  fetch("../index.json").then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((entries) => {
    const nodes = [];
    const weekly = entries.filter((e) => e.edition === "weekly");
    if (weekly.length) { nodes.push(group("Weekly editions")); for (const e of weekly.slice(0, 6)) nodes.push(item(e)); }
    let week = "";
    for (const e of entries.filter((x) => x.edition !== "weekly")) {
      const w = weekOf(e.date);
      if (w !== week) { week = w; nodes.push(group(`Week of ${fmt(w, { day: "numeric", month: "short" })}`)); }
      nodes.push(item(e));
    }
    list.replaceChildren(...nodes);
  }).catch((err) => console.warn("[daily] editions list unavailable:", err));
  requestAnimationFrame((now) => { last = now; frame(now); });
})();
