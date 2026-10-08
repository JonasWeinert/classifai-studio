// Window dragging for the overlay title bar. Tauri's data-tauri-drag-region only reacts to presses on
// the exact element carrying it, so instead any press on empty space inside a `.titlebar` (toolbar,
// sidebar header, onboarding) drags the window, and a double-click zooms it like a native title bar.
const INTERACTIVE = "button, a, input, textarea, select, label, [role=button], [role=switch], [role=tab], [contenteditable=true], [data-no-drag]";

export function installWindowDrag() {
  let win: typeof import("@tauri-apps/api/window") | null = null;
  import("@tauri-apps/api/window").then((m) => (win = m));

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || !win) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".titlebar") || target.closest(INTERACTIVE)) return;
    e.preventDefault();
    const w = win.getCurrentWindow();
    if (e.detail === 2) w.toggleMaximize();
    else w.startDragging();
  };
  document.addEventListener("mousedown", onMouseDown);
  return () => document.removeEventListener("mousedown", onMouseDown);
}
