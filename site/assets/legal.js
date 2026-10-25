// Scroll-spy for the legal pages' contents sidebar.
//
// Highlights the section you are actually reading. Tracks headings by their distance past
// the sticky header rather than by intersection ratio: a short section can never occupy
// enough of the viewport to win on ratio, so ratio-based spies skip over them entirely.
(function () {
  const nav = document.querySelector(".legal-nav");
  if (!nav) return;

  const links = [...nav.querySelectorAll("a[href^='#']")];
  const sections = links
    .map((a) => ({ link: a, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
    .filter((s) => s.el);
  if (!sections.length) return;

  const OFFSET = 110; // sticky header + a little breathing room
  let current = null;

  function sync() {
    // The active section is the last one whose heading has passed the offset line. At the
    // very bottom of the page, prefer the final section so the last item can light up even
    // when its heading sits above the line but the page cannot scroll further.
    let active = sections[0];
    for (const s of sections) {
      if (s.el.getBoundingClientRect().top <= OFFSET) active = s;
    }
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 2) {
      active = sections[sections.length - 1];
    }
    if (active.link === current) return;
    if (current) current.classList.remove("on");
    active.link.classList.add("on");
    current = active.link;

    // Keep the active entry visible when the list is long enough to scroll on its own.
    if (nav.scrollHeight > nav.clientHeight) {
      const a = current.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      if (a.top < n.top + 8 || a.bottom > n.bottom - 8) {
        current.scrollIntoView({ block: "nearest" });
      }
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { sync(); ticking = false; });
  }

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  sync();

  // Smooth-scroll the in-page jumps, and put the section in the address bar so a link to
  // a clause can be copied straight out of it.
  for (const a of links) {
    a.addEventListener("click", (e) => {
      const target = document.getElementById(decodeURIComponent(a.hash.slice(1)));
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - (OFFSET - 18);
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
      history.replaceState(null, "", a.hash);
    });
  }
})();
