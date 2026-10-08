//! Window building, window commands, tiling/reading order, and Windows minimize cascade.

use crate::*;

/// Windows-only: per-window last-known minimized state. Used to detect the
/// minimized→restored edge in `Resized` events (on Windows, minimize fires
/// `Resized(0,0)` / `is_minimized()==true`, restore fires `Resized(real)` /
/// `is_minimized()==false`) so that restoring ONE window brings all its
/// siblings back too — matching the macOS dock-reopen behavior. On macOS the
/// OS already restores every window from a single dock click, so the whole
/// `Resized` arm is compiled out there and this state is never populated.
#[cfg(target_os = "windows")]
#[derive(Default)]
pub(crate) struct MinimizeState(pub(crate) Mutex<HashMap<String, bool>>);

/// Windows-only: on the minimized→restored edge of one window, un-minimize
/// every sibling ON THE CURRENT PAGE so a single taskbar click brings the
/// workspace back (like macOS). Ordinary resizes/drags are ignored — only a
/// true minimized→restored transition triggers the cascade. We pre-mark every
/// window as restored before calling `unminimize()`, so the `Resized` events
/// those calls generate don't re-cascade. No `set_focus()` — un-minimizing
/// siblings must not steal focus from the window the user actually clicked.
///
/// The page filter is load-bearing: `unminimize()` is `SW_RESTORE`, which
/// SHOWS the window. Cascading to every sibling would drag all of page 2 onto
/// the screen on top of page 1 — the whole workspace popping up at once, which
/// is exactly what paging exists to prevent.
#[cfg(target_os = "windows")]
pub(crate) fn restore_sibling_windows(window: &tauri::Window) {
    let app = window.app_handle();
    let label = window.label().to_string();
    let cur = window.is_minimized().unwrap_or(false);
    let state: State<MinimizeState> = app.state();
    // Act only on an actual minimized (prev) → restored (cur == false) edge.
    let cascade = {
        let mut map = state.0.lock_or_recover();
        let prev = map.get(&label).copied().unwrap_or(false);
        map.insert(label.clone(), cur);
        prev && !cur
    };
    if !cascade {
        return;
    }
    // Auxiliary windows (What's New) carry no page and are left alone here;
    // project windows cascade only when they share the visible page.
    let page = current_page(app);
    let pages = window_page_map(app);
    // Collect siblings AND pre-mark every window restored, holding the lock only
    // briefly — never across a window call. `unminimize()` on Windows can
    // synchronously re-enter this handler (ShowWindow dispatches WM_SIZE), so a
    // lock held across it would deadlock the (non-reentrant) mutex. Pre-marking
    // makes any such re-entrant call read prev == false and skip the cascade.
    let siblings: Vec<WebviewWindow> = {
        let mut map = state.0.lock_or_recover();
        let mut out = Vec::new();
        for (sib_label, win) in app.webview_windows() {
            map.insert(sib_label.clone(), false);
            if sib_label == label {
                continue;
            }
            if pages.get(&sib_label).is_some_and(|p| *p != page) {
                continue;
            }
            out.push(win);
        }
        out
    };
    for win in siblings {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
    }
}

/// App background (#111317) painted on the native window + webview BEFORE the
/// first frame, so opening a new window never flashes white.
pub(crate) const APP_BG: tauri::window::Color = tauri::window::Color(15, 17, 21, 255);

/// Per-OS window chrome decision. macOS uses the Overlay title bar (webview
/// draws under the traffic lights); every other OS keeps native decorations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowChrome {
    MacOverlay,
    Native,
}

/// Compile-time chrome selection: Overlay only on macOS, native elsewhere.
pub(crate) fn window_chrome() -> WindowChrome {
    if cfg!(target_os = "macos") {
        WindowChrome::MacOverlay
    } else {
        WindowChrome::Native
    }
}

/// Apply the macOS Overlay title bar + hidden title to a window builder. Kept
/// behind `#[cfg(target_os = "macos")]` because `TitleBarStyle::Overlay` and
/// `hidden_title` are macOS-only builder methods.
#[cfg(target_os = "macos")]
pub(crate) fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

/// No-op on non-macOS: native chrome is the default, nothing to apply.
#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// Build an app window with the standard chrome. On macOS this includes the
/// Overlay title bar + `hidden_title(true)` so the native title text never
/// shows — the in-app `chat-head-title` is the ONLY title. Building via the
/// builder (rather than the config + a runtime patch) is the only way to hide
/// the native title, since there's no runtime `set_hidden_title` setter.
pub(crate) fn build_app_window_with_visibility(
    app: &tauri::AppHandle,
    label: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("EZ Coder")
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .background_color(APP_BG)
        .visible(visible);
    // Windows needs HTML5 drop enabled for the existing browser attachment path.
    // macOS keeps Tauri's native handler so folder drops include absolute paths.
    #[cfg(target_os = "windows")]
    {
        builder = builder.disable_drag_drop_handler();
    }
    if matches!(window_chrome(), WindowChrome::MacOverlay) {
        builder = apply_mac_overlay(builder);
    }
    builder.build().map_err(|e| e.to_string())
}

pub(crate) fn build_app_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<WebviewWindow, String> {
    build_app_window_with_visibility(app, label, true)
}

/// Open enough new project windows to reach `count` total (each with its own
/// agent sidecar at the default cwd), then show page 1 tiled across the work
/// area like macOS fill&arrange. Project selection per window happens in-app
/// via the picker; windows open immediately.
///
/// `count` may exceed `PAGE_SIZE` (the 12-window layout): the surplus windows
/// are created HIDDEN on later pages so the grid on screen never exceeds 6
/// cells. Their sessions live in the shared daemon, so those agents run
/// normally while off-page.
///
/// MUST be `async`: on Windows, `WebviewWindowBuilder::build()` deadlocks when
/// called from a SYNCHRONOUS command (WebView2 runs window creation on the
/// event loop the sync command is blocking). The symptom was a blank,
/// unresponsive, uncloseable window. An async command runs off that thread, so
/// creation completes normally. See the docs.rs WebviewWindowBuilder "Known
/// issues" note.
#[tauri::command]
pub(crate) async fn setup_windows(app: tauri::AppHandle, count: usize) -> Result<(), String> {
    let existing = arrangeable_windows(&app).len();
    let to_create = count.saturating_sub(existing);
    for _ in 0..to_create {
        let label = next_window_label(&app);
        // Every new window is born HIDDEN, whatever page it lands on. The
        // `queue_page` below tiles page 1 and then shows it, so page-1 windows
        // arrive already in their cell instead of appearing at full size and
        // snapping; page-2+ windows simply stay down. Building them visible
        // also popped them over whichever page was up at the time.
        //
        // macOS-only chrome: the Overlay title bar + hidden title lets the
        // webview draw under the traffic lights. Windows/Linux keep native
        // chrome (Overlay is a no-op / unsupported there) and the webview CSS
        // drops the mac traffic-light insets via the `.platform-*` class.
        build_app_window_with_visibility(&app, &label, false)?;
        start_window_session(
            app.clone(),
            label,
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
    }
    // The user picked `count`, so honour it as the grid size even when the
    // workspace already had more windows open than that.
    queue_page(&app, 1, Some(count), None);
    Ok(())
}

/// The page each project window sits on, keyed by label.
///
/// Derived on demand from the stable label order (main, project-1, project-2,
/// …), 6 per page — never stored. That means there is no page state to keep in
/// sync: closing a window automatically re-packs the pages below it, pulling
/// the next window up into the hole rather than leaving a gap in the grid.
pub(crate) fn window_page_map(app: &tauri::AppHandle) -> HashMap<String, u8> {
    let mut windows = arrangeable_windows(app);
    windows.sort_by_key(|w| label_rank(w.label()));
    windows
        .iter()
        .enumerate()
        .map(|(index, win)| (win.label().to_string(), page_for_index(index, PAGE_SIZE)))
        .collect()
}

/// The page on screen, clamped to the pages that actually hold windows.
///
/// The clamp is what stops a closed window stranding the user on a blank
/// screen: drop from 7 windows to 6 while page 2 is up and page 2 no longer
/// exists, so "current" has to fall back to a page that does.
fn current_page(app: &tauri::AppHandle) -> u8 {
    let pages = page_count(arrangeable_windows(app).len(), PAGE_SIZE);
    (*app.state::<CurrentPage>().0.lock().unwrap()).clamp(1, pages)
}

/// Queue a page switch on the MAIN thread. Every page change goes through
/// here.
///
/// Why the main thread rather than the caller's: `show()`/`hide()`/`set_focus()`
/// dispatch to the window server, so two `apply_page` calls racing on different
/// threads interleave their hide and show batches — the screen ends up holding
/// half of each page. Draining them through the event loop gives page switches
/// a total order (last one queued wins, which is what the user pressed last),
/// and nothing holds a lock across a window call, so a switch can't deadlock
/// against the event loop it is driving.
///
/// Queuing from the main thread is still a queue, not a direct call — that is
/// deliberate in the `Destroyed` handler, where the re-page must run AFTER the
/// window being closed is actually gone.
pub(crate) fn queue_page(
    app: &tauri::AppHandle,
    page: u8,
    tile_count: Option<usize>,
    focus: Option<String>,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply_page(&handle, page, tile_count, focus.as_deref());
    });
}

/// Make `page` the visible one: hide every other page's windows, show this
/// page's, re-tile what's left on screen, settle focus, and broadcast the new
/// order. MAIN THREAD ONLY — reach it through `queue_page`.
///
/// Hiding precedes showing so the screen never briefly holds 12 windows.
///
/// Focus is placed EXPLICITLY at the end, and that is load-bearing. Hiding the
/// focused window makes the window server hand key status to whatever it likes
/// next — routinely a window on the page we just left. An earlier version let a
/// `Focused` event drag `CurrentPage` back to that window's page, which fought
/// the switch already in flight and ping-ponged the two pages on screen. Now
/// nothing follows focus; the page switch decides where focus lands.
///
/// `tile_count` is the GRID SIZE, not a filter: `arrange_these` lays out a
/// `tile_count`-cell grid, so passing PAGE_SIZE with only 2 windows open would
/// squeeze them into two sixths of the screen. `None` means "one cell per
/// window on the page", which is what every caller but `setup_windows` wants;
/// `setup_windows` passes the count the user explicitly picked.
///
/// `focus` names the window to leave focused; `None` keeps the current one when
/// it is on this page and otherwise falls to the page's first window.
fn apply_page(app: &tauri::AppHandle, page: u8, tile_count: Option<usize>, focus: Option<&str>) {
    // Mid-quit every window is being torn down; re-tiling the survivors just
    // races the teardown.
    if app.state::<AppExiting>().0.load(Ordering::SeqCst) {
        return;
    }
    *app.state::<CurrentPage>().0.lock().unwrap() = page;
    let pages = window_page_map(app);
    let windows = arrangeable_windows(app);
    let mut on_page: Vec<WebviewWindow> = Vec::new();
    for win in &windows {
        if pages.get(win.label()).copied().unwrap_or(1) == page {
            on_page.push(win.clone());
        } else {
            let _ = win.hide();
        }
    }
    on_page.sort_by_key(|w| label_rank(w.label()));
    let tiles = page_tile_count(tile_count, on_page.len());
    let focus_target = focus
        .map(str::to_string)
        .or_else(|| app.state::<FocusedWindow>().0.lock().unwrap().clone())
        .filter(|label| on_page.iter().any(|w| w.label() == label))
        .or_else(|| on_page.first().map(|w| w.label().to_string()));
    on_page.truncate(tiles);
    // Tile BEFORE showing. A window that is ordered in first and moved second
    // appears at its old size/place for a frame and then jumps — across six
    // windows that reads as the page flashing and popping in at random. Sizing
    // an off-screen window is free, and `tile_area` reads the monitor list
    // rather than the window's own screen, so it works while hidden.
    arrange_these(on_page.clone(), tiles);
    for win in &on_page {
        let _ = win.show();
    }
    // Last, so focus lands on a window that is already up and in place.
    if let Some(win) = focus_target.and_then(|label| app.get_webview_window(&label)) {
        let _ = win.set_focus();
    }
    broadcast_window_order(app);
}

/// Switch the visible page (1-based). A page that doesn't exist, or the one
/// already on screen, is a no-op rather than an error: `Cmd+3` on a two-page
/// workspace does nothing, and `Cmd+1` when page 1 is already up must NOT
/// re-tile hand-placed windows.
///
/// Mashing the shortcut is safe: the switches queue on the main thread and run
/// in the order pressed, so the last key wins instead of two half-applied
/// pages fighting over the screen.
///
/// `async` for the same WebView2 reason as `setup_windows`: window show/hide
/// from a synchronous command can deadlock the event loop it is blocking.
#[tauri::command]
pub(crate) async fn show_page(app: tauri::AppHandle, page: u8) -> Result<(), String> {
    let total = arrangeable_windows(&app).len();
    if page == 0 || page > page_count(total, PAGE_SIZE) || page == current_page(&app) {
        return Ok(());
    }
    queue_page(&app, page, None, None);
    Ok(())
}

/// Current page + how many pages exist, for the window-layout menu.
#[tauri::command]
pub(crate) fn window_pages(app: tauri::AppHandle) -> serde_json::Value {
    let total = arrangeable_windows(&app).len();
    serde_json::json!({
        "current": current_page(&app),
        "pages": page_count(total, PAGE_SIZE),
    })
}

/// Open a single new project window with its own agent sidecar (default cwd) and
/// focus it. Unlike `setup_windows`, this never re-tiles the page the user is
/// already on — it's the Cmd/Ctrl+N "new window" shortcut. Project selection
/// happens per-window.
///
/// When the visible page is already full, the new window lands on a later page,
/// so we switch to that page rather than leaving the user staring at an
/// unchanged screen after asking for a new window. It is BUILT HIDDEN in that
/// case: a window born visible on a page that isn't up flashes full-size over
/// the current page before the switch can hide it.
///
/// `async` for the same reason as `setup_windows`: a synchronous window-building
/// command deadlocks WebView2 on Windows.
#[tauri::command]
pub(crate) async fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = next_window_label(&app);
    // The new window takes the next slot, so its page is known before it exists.
    let target = page_for_index(arrangeable_windows(&app).len(), PAGE_SIZE);
    let current = current_page(&app);
    let win = build_app_window_with_visibility(&app, &label, target == current)?;
    start_window_session(
        app.clone(),
        label.clone(),
        WorkspaceMode::Code,
        ChatAgent::General,
        default_cwd(),
        None,
    );
    if target == current {
        let _ = win.set_focus();
        broadcast_window_order(&app);
    } else {
        // The switch shows, tiles and focuses the newcomer, then broadcasts.
        queue_page(&app, target, None, Some(label));
    }
    Ok(())
}

/// The "What's new" modal lives in its OWN dedicated window so it appears EXACTLY
/// once (the main webview decides; see WhatsNewTrigger) and centers on the user's
/// SCREEN rather than inside whichever tiled project window happens to be open.
/// Reuses `index.html` with a `?whatsnew=1` flag — main.tsx renders only the
/// modal for that flag, so no second Vite entry / build-config change is needed.
/// Borderless + centered + always-on-top + off the taskbar so it reads as a
/// transient OS dialog. The window closes itself from the webview
/// (`getCurrentWebviewWindow().close()`); re-invoking just refocuses an open one.
///
/// `mode` picks the mood: `"hype"` is the one-time show after an update
/// relaunch, anything else (the home screen's button) is the calm read.
///
/// `async` for the same WebView2 reason as `setup_windows`/`new_window`.
#[tauri::command]
pub(crate) async fn open_whatsnew_window(
    app: tauri::AppHandle,
    mode: Option<String>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WHATSNEW_LABEL) {
        let _ = win.set_focus();
        return Ok(());
    }
    // Built hidden: the page reveals it once its first frame has painted, so
    // the user never sees an empty or half-styled window.
    WebviewWindowBuilder::new(
        &app,
        WHATSNEW_LABEL,
        WebviewUrl::App(whatsnew_url(mode.as_deref()).into()),
    )
    .title("What's new")
    .inner_size(600.0, 640.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    // Fail closed: a page that never loads must not leave a hidden window
    // around (it would swallow the next "What's new" click as a refocus).
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WHATSNEW_REVEAL_TIMEOUT).await;
        if let Some(win) = app2.get_webview_window(WHATSNEW_LABEL) {
            if !win.is_visible().unwrap_or(true) {
                log::warn!("What's new window never revealed itself; closing it");
                let _ = win.close();
            }
        }
    });
    Ok(())
}

const WHATSNEW_LABEL: &str = "whatsnew";
/// How long the page gets to paint and call `reveal_whatsnew_window`.
const WHATSNEW_REVEAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Called by the What's-new page once its first frame is painted: show the
/// (so far hidden) window and focus it. Only that window may reveal itself.
#[tauri::command]
pub(crate) fn reveal_whatsnew_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WHATSNEW_LABEL {
        return Err("only the What's new window can reveal itself".into());
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// The What's-new page URL. Only the two known moods reach the webview; an
/// unknown value falls back to calm rather than being passed through.
fn whatsnew_url(mode: Option<&str>) -> &'static str {
    match mode {
        Some("hype") => "index.html?whatsnew=1&mode=hype",
        _ => "index.html?whatsnew=1&mode=calm",
    }
}

/// Cycle keyboard focus by `offset` (±1) through windows in reading order,
/// wrapping around. No-op when ≤1 window is open. Forward = +1, backward = -1
/// (Shift held). Bound to Cmd/Ctrl + Backquote (±Shift).
#[tauri::command]
pub(crate) fn focus_window_by_offset(app: tauri::AppHandle, offset: i32) -> Result<(), String> {
    let order = compute_window_order(&app);
    if order.len() <= 1 {
        return Ok(());
    }
    let cur = app
        .state::<FocusedWindow>()
        .0
        .lock_or_recover()
        .clone()
        .and_then(|f| order.iter().position(|l| l == &f))
        .unwrap_or(0) as i32;
    let len = order.len() as i32;
    // Wrap-safe modulo for negative offsets (backward cycling).
    let next = ((cur + offset) % len + len) % len;
    if let Some(label) = order.get(next as usize) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Re-tile EVERY currently open window into a clean grid (no create/destroy),
/// then broadcast the new order. Works for any count (3, 5, 7, 9, 12, …).
///
/// Applies the rects in a STAGGERED async loop (~30ms between windows). On macOS
/// `set_size`/`set_position` dispatch to the main thread asynchronously, and
/// firing all of them in a tight loop lets the window server coalesce the later
/// dispatches — so the trailing windows would move but keep their old size.
/// Staggering lets each window's size+position fully commit before the next's
/// hits the main-thread queue.
#[tauri::command]
pub(crate) async fn arrange_all(app: tauri::AppHandle) -> Result<(), String> {
    let tiles = sorted_windows(&app, usize::MAX);
    let count = tiles.len();
    let (rects, scale) = if tiles.is_empty() {
        (Vec::new(), 1.0)
    } else {
        let Some((ox, oy, w, h, scale)) = tile_area(&tiles[0]) else {
            broadcast_window_order(&app);
            return Ok(());
        };
        (tile_rects(count, ox, oy, w, h), scale)
    };
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect, scale);
        // Let the main thread commit this window before queuing the next.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    broadcast_window_order(&app);
    Ok(())
}

/// Another window already bound to a project directory, reported by
/// `project_open_windows` so the picker can warn before opening a duplicate.
#[derive(serde::Serialize)]
pub(crate) struct ProjectWindowConflict {
    /// Window label already bound to this cwd.
    label: String,
    /// Human-friendly title: custom_title when set, else the directory name.
    title: String,
}

/// Normalize a path for cross-window comparison. Canonicalization resolves
/// symlinks and `..`; a missing path keeps its literal form so a not-yet-created
/// project still compares equal to itself.
fn normalize_for_compare(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(real) => strip_extended_prefix(real),
        Err(_) => path.to_path_buf(),
    }
}

/// Pure core of `project_open_windows`: every entry other than `self_label`
/// whose cwd normalizes to `target`. Kept free of Tauri types so it is unit
/// testable without a running app.
fn conflicting_windows(
    entries: &[(String, Option<PathBuf>, Option<String>)],
    self_label: &str,
    target: &Path,
) -> Vec<ProjectWindowConflict> {
    let target = normalize_for_compare(target);
    entries
        .iter()
        .filter(|(label, _, _)| label != self_label)
        .filter_map(|(label, cwd, custom_title)| {
            let cwd = cwd.as_deref()?;
            if normalize_for_compare(cwd) != target {
                return None;
            }
            let title = custom_title.clone().unwrap_or_else(|| {
                cwd.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| label.clone())
            });
            Some(ProjectWindowConflict {
                label: label.clone(),
                title,
            })
        })
        .collect()
}

/// Windows OTHER than this one that already have `cwd` open. Empty when the
/// project is free, so the picker can open it without prompting.
#[tauri::command]
pub(crate) fn project_open_windows(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    cwd: String,
) -> Vec<ProjectWindowConflict> {
    let self_label = webview.label().to_string();
    // Live labels first: a registry row can outlive its window, and a stale row
    // would report a conflict against a window the user cannot switch to.
    let live: HashSet<String> = app.webview_windows().into_keys().collect();
    // Collect and DROP the lock before anything else — window calls under this
    // (non-reentrant) mutex deadlock, see the minimize cascade above.
    let entries: Vec<(String, Option<PathBuf>, Option<String>)> = {
        let windows: State<Windows> = app.state();
        let map = windows.map.lock().unwrap();
        map.iter()
            .filter(|(label, _)| live.contains(*label))
            .map(|(label, w)| (label.clone(), w.cwd.clone(), w.custom_title.clone()))
            .collect()
    };
    conflicting_windows(&entries, &self_label, Path::new(&cwd))
}

/// Proxy: create an isolated git worktree for `cwd` so this window can work on
/// a repo another window already holds. Returns the daemon's
/// `{ path, branch, baseRef, setup }`; the caller then `select_project`s into
/// `path`.
///
/// The daemon answers 409 for the one case the user must resolve (not a git
/// repo), carrying a human-readable `error` which is surfaced verbatim rather
/// than flattened into a generic failure.
///
/// The shared client's 30s timeout is overridden here: creating the worktree is
/// instant, but the daemon then installs the project's dependencies into it,
/// and a cold monorepo install runs for minutes. At 30s the window would report
/// a failure for a copy that was in fact being built correctly, and then create
/// a SECOND one on the retry.
#[tauri::command]
pub(crate) async fn create_worktree(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    branch: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let ez_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/worktree", sidecar_base(port)))
        .header("x-ez-session", &ez_sid)
        .json(&serde_json::json!({ "cwd": cwd, "branch": branch }))
        .timeout(std::time::Duration::from_secs(20 * 60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("Could not create the worktree.")
            .to_string());
    }
    Ok(body)
}

/// Proxy: every managed copy of `cwd`'s repo, with the state the picker needs
/// to decide what to offer. `busy_paths` are the directories live windows hold;
/// the daemon has no window knowledge, so the caller supplies them.
#[tauri::command]
pub(crate) async fn list_worktrees(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    busy_paths: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let ez_sid = session_for(&webview).ok_or("session not ready")?;
    let mut req = client
        .get(format!("{}/worktrees", sidecar_base(port)))
        .header("x-ez-session", &ez_sid)
        .query(&[("cwd", &cwd)]);
    for path in busy_paths.unwrap_or_default() {
        req = req.query(&[("busy", path)]);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: remove one copy. The daemon answers 409 with a human-readable reason
/// when the copy still holds work and `force` was not given; that text is
/// surfaced verbatim, exactly as `create_worktree` does with its own gate.
#[tauri::command]
pub(crate) async fn remove_worktree(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    path: String,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let ez_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .request(
            reqwest::Method::DELETE,
            format!("{}/worktree", sidecar_base(port)),
        )
        .header("x-ez-session", &ez_sid)
        .json(&serde_json::json!({
            "cwd": cwd,
            "path": path,
            "force": force.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("reason")
            .or_else(|| body.get("error"))
            .and_then(|e| e.as_str())
            .unwrap_or("That copy could not be cleaned up.")
            .to_string());
    }
    Ok(body)
}

/// The cwds of every LIVE window, so a sweep never reclaims a copy someone is
/// working in. Mirrors `project_open_windows`' lock discipline: collect under
/// the mutex, then drop it before anything else runs.
pub(crate) fn live_window_cwds(app: &tauri::AppHandle, exclude_label: Option<&str>) -> Vec<String> {
    let live: HashSet<String> = app.webview_windows().into_keys().collect();
    let windows: State<Windows> = app.state();
    let map = windows.map.lock().unwrap();
    map.iter()
        .filter(|(label, _)| live.contains(*label))
        .filter(|(label, _)| Some(label.as_str()) != exclude_label)
        .filter_map(|(_, w)| w.cwd.as_ref())
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .collect()
}

/// Fire-and-forget reclaim of every copy of `cwd`'s repo that holds no work.
///
/// Bounded and silent by design: this runs on window close and on daemon
/// startup, where the user is not watching and a hung git must not wedge the
/// close. The sweep never forces, so the worst outcome of a failure is a copy
/// that stays on disk and appears in the picker's list instead.
pub(crate) async fn sweep_worktrees_for(
    app: &tauri::AppHandle,
    port: u16,
    cwd: String,
    busy: Vec<String>,
) {
    let client = app.state::<reqwest::Client>().inner().clone();
    if let Err(err) = client
        .post(format!("{}/worktrees/sweep", sidecar_base(port)))
        .json(&serde_json::json!({ "cwd": cwd, "busyPaths": busy }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        log::warn!("worktree sweep failed for {cwd}: {err}");
    }
}

/// Re-point THIS window's agent at a chosen project: dispose its current daemon
/// session and create a fresh one at `cwd`, optionally resuming the session file
/// `session_path`. The command resolves only after the daemon session is ready,
/// so a failed resume stays in the picker instead of opening an endless skeleton.
#[tauri::command]
pub(crate) async fn select_project(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    // The existing daemon session is about to be retired. Remove its durable
    // target first so a failed switch or mid-switch webview reload cannot reopen
    // a workspace whose session has already been disposed.
    remove_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        &label,
    );
    snapshot_workspace(&app);

    // Take the old session id (and clear it) so the old SSE bridge retires.
    // Keep the window label: it belongs to the window, not one project session.
    let (old_id, custom_title) = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock_or_recover();
        let window = map.get_mut(&label);
        let custom_title = window
            .as_ref()
            .and_then(|window| window.custom_title.clone());
        let old_id = window.and_then(|window| window.session_id.take());
        (old_id, custom_title)
    };
    // Dispose the old session on the daemon (best-effort, off-thread).
    if let Some(id) = old_id {
        if let Some(port) = port_for(&webview) {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                daemon_delete_session(&app2, port, &id).await;
            });
        }
    }

    let target = RestoreEntry {
        mode,
        chat_agent,
        cwd: cwd.clone(),
        session_path: session_path.clone(),
        custom_title,
    };
    let cwd = PathBuf::from(cwd);
    let generation = prepare_window_session(
        &app,
        &label,
        mode,
        chat_agent,
        &cwd,
        session_path.as_deref(),
    );
    finish_window_session(
        app.clone(),
        label.clone(),
        mode,
        chat_agent,
        cwd,
        session_path,
        generation,
    )
    .await?;

    // Publish the target only after the daemon confirms the selection. Keeping
    // it for the window lifetime lets a reloaded webview recover in place.
    register_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        label,
        target,
    );
    snapshot_workspace(&app);
    Ok(())
}

/// Map a normalized gaze point to a window and (optionally) focus it.
///
/// The webview can't see other windows' screen rectangles, so the gaze tracker
/// (which only knows a normalized point across the primary monitor) hands the
/// point to Rust. We convert it to physical coordinates using the primary
/// monitor work area, hit-test every open window's outer rect, then:
///   - emit `gaze-target { target, committed }` to ALL windows so each paints
///     its own border: the `committed` (currently focused) window holds a solid
///     ring, the `target` window a soft "dwelling here" highlight, and
///   - call `set_focus()` on the hit window only when `commit` is true (after
///     the controller's dwell), so a glance never steals keyboard focus.
///
/// `committed` is the controller's currently-focused window label, passed every
/// frame so the focused border PERSISTS rather than flashing for one frame.
///
/// Returns the hit window's label (or null when the point lands on no window).
#[tauri::command]
pub(crate) fn gaze_focus(
    app: tauri::AppHandle,
    nx: f64,
    ny: f64,
    commit: bool,
    committed: Option<String>,
) -> Result<Option<String>, String> {
    let windows = app.webview_windows();
    let Some(any) = windows.values().next() else {
        return Ok(None);
    };
    let Some(monitor) = any.primary_monitor().ok().flatten() else {
        return Ok(None);
    };
    let area = monitor.work_area();
    let nx = nx.clamp(0.0, 1.0);
    let ny = ny.clamp(0.0, 1.0);
    let px = area.position.x as f64 + nx * area.size.width as f64;
    let py = area.position.y as f64 + ny * area.size.height as f64;

    // Hit-test: first window whose outer rect contains the point.
    let mut target: Option<String> = None;
    for (label, win) in windows.iter() {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let x0 = pos.x as f64;
        let y0 = pos.y as f64;
        let x1 = x0 + size.width as f64;
        let y1 = y0 + size.height as f64;
        if px >= x0 && px < x1 && py >= y0 && py < y1 {
            target = Some(label.clone());
            break;
        }
    }

    // Broadcast both labels to every window; each computes its own border style.
    for (label, win) in windows.iter() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "gaze-target",
            serde_json::json!({ "target": target, "committed": committed }),
        );
        if commit {
            if let Some(t) = &target {
                if t == label {
                    let _ = win.set_focus();
                }
            }
        }
    }
    Ok(target)
}

/// Allocate a unique `project-N` window label.
pub(crate) fn next_window_label(app: &tauri::AppHandle) -> String {
    let mut n = 1;
    loop {
        let label = format!("project-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Pure: the tile rects `(x, y, width, height)` for `count` windows arranged in
/// a generalized grid (`cols = ceil(sqrt(N))`) filling the work area `(ox, oy, w, h)`,
/// in order (row-major: left→right within a row, top→bottom across rows).
pub(crate) fn tile_rects(
    count: usize,
    ox: i32,
    oy: i32,
    w: i32,
    h: i32,
) -> Vec<(i32, i32, u32, u32)> {
    if count == 0 {
        return Vec::new();
    }
    let cols = grid_cols(count);
    let rows: i32 = ((count as i32) + cols - 1) / cols;
    let cell_w = w / cols;
    let cell_h = h / rows;
    (0..count as i32)
        .map(|i| {
            let col = i % cols;
            let row = i / cols;
            (
                ox + col * cell_w,
                oy + row * cell_h,
                cell_w as u32,
                cell_h as u32,
            )
        })
        .collect()
}

/// Resolve the work area the tiler should fill: the user's chosen `targetMonitor`
/// (matched by stable key), else auto — an external display ahead of the built-in
/// laptop panel (see `choose_monitor`). `win` is any open window —
/// it's only used to enumerate monitors. Returns `(ox, oy, w, h, scale)` where the
/// rect is in PHYSICAL pixels and `scale` is the TARGET monitor's scale factor
/// (needed by `apply_tile` to place windows correctly across mismatched-DPI
/// displays). Returns `None` if no monitor is available (e.g. fully headless).
fn tile_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
    let want = target_monitor_name();
    let (mut monitors, facts): (Vec<tauri::Monitor>, Vec<MonitorFacts>) =
        monitor_facts(win).into_iter().unzip();
    let monitor = match choose_monitor(&facts, want.as_deref()) {
        Some(i) => monitors.swap_remove(i),
        None => win.primary_monitor().ok().flatten()?,
    };
    let area = monitor.work_area();
    Some((
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        monitor.scale_factor(),
    ))
}

/// Only project windows participate in arrangement and keyboard cycling. Auxiliary
/// windows such as the What's New dialog must remain untouched.
fn is_arrangeable_window_label(label: &str) -> bool {
    label == "main"
        || label
            .strip_prefix("project-")
            .is_some_and(|suffix| suffix.parse::<u32>().is_ok())
}

/// Every project window, on any page — including hidden ones. Use this for
/// counting and page assignment, never for tiling.
fn arrangeable_windows(app: &tauri::AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(|window| is_arrangeable_window_label(window.label()))
        .collect()
}

/// Project windows the user can actually see — i.e. the ones on the current
/// page. Tiling, the `n/6` badge and `Cmd+\`` cycling all work from this, so
/// off-page windows are never tiled into the grid nor cycled into focus.
///
/// DERIVED from the page map, deliberately NOT from `is_visible()`.
/// `show()`/`hide()` dispatch to the window server, so an `is_visible()` read
/// taken right after a page switch (or during restore) can still report the
/// OLD value — which silently dropped freshly shown windows out of the grid and
/// left them stacked at default size. The page map is the single source of
/// truth for what is on screen, and it answers instantly.
fn visible_arrangeable_windows(app: &tauri::AppHandle) -> Vec<WebviewWindow> {
    let page = current_page(app);
    let pages = window_page_map(app);
    arrangeable_windows(app)
        .into_iter()
        .filter(|window| pages.get(window.label()).copied().unwrap_or(1) == page)
        .collect()
}

/// The first `count` VISIBLE project windows (main first, then project-N
/// ascending).
pub(crate) fn sorted_windows(app: &tauri::AppHandle, count: usize) -> Vec<WebviewWindow> {
    let mut windows = visible_arrangeable_windows(app);
    windows.sort_by_key(|w| label_rank(w.label()));
    windows.into_iter().take(count).collect()
}

/// Pure: 0-based creation index → 1-based page number.
pub(crate) fn page_for_index(index: usize, page_size: usize) -> u8 {
    let size = page_size.max(1);
    ((index / size) + 1).min(u8::MAX as usize) as u8
}

/// Pure: how many pages `total` windows occupy (always at least 1).
fn page_count(total: usize, page_size: usize) -> u8 {
    let size = page_size.max(1);
    (total.div_ceil(size).max(1)).min(u8::MAX as usize) as u8
}

/// Pure: the grid size `apply_page` should tile with. `requested` is the count
/// the user explicitly picked (`setup_windows`); `on_page` is how many windows
/// the target page actually holds. Capped at PAGE_SIZE, and never 0 — a
/// 0-cell grid would divide by zero in `tile_rects`.
///
/// The cap matters: tiling 2 open windows into a PAGE_SIZE grid would shrink
/// them to a sixth of the screen instead of a half each. So does the floor at
/// `on_page`: asking for "2 windows" while 6 are already on the page must lay
/// out all 6, not tile 2 of them and leave 4 stacked at their old size.
fn page_tile_count(requested: Option<usize>, on_page: usize) -> usize {
    requested
        .unwrap_or(on_page)
        .max(on_page)
        .clamp(1, PAGE_SIZE)
}

/// Pure: the page to fall back to when the visible page has just been emptied.
/// Prefers the nearest lower page, else the nearest higher one, so closing the
/// last window of page 2 lands you back on page 1 rather than nowhere.
/// `None` means no windows are left at all — nothing to switch to.
fn fallback_page(pages_with_windows: &[u8], current: u8) -> Option<u8> {
    if pages_with_windows.contains(&current) {
        return None;
    }
    let below = pages_with_windows.iter().filter(|p| **p < current).max();
    let above = pages_with_windows.iter().filter(|p| **p > current).min();
    below.or(above).copied()
}

/// Pure: after a window closes, the page to re-apply — or `None` to leave the
/// screen alone. `stored` is the RAW stored page, which may point past the last
/// page that still exists.
///
/// A single-page workspace still on page 1 is left alone, so closing one of
/// three hand-placed windows doesn't re-tile the survivors. Anything else
/// re-applies: several pages (a close re-packs them), or a stored page that no
/// longer exists (closing all of page 2 must bring page 1 back on screen).
pub(crate) fn repage_target(pages_with_windows: &[u8], stored: u8) -> Option<u8> {
    if pages_with_windows.is_empty() || (pages_with_windows.len() == 1 && stored <= 1) {
        return None;
    }
    Some(fallback_page(pages_with_windows, stored).unwrap_or(stored))
}

/// Apply one tile rect (TARGET-monitor physical pixels) to a window. `scale` is the
/// target monitor's scale factor.
///
/// Order matters: `set_size` and `set_position` both dispatch to the main thread
/// asynchronously and `setFrameTopLeftPoint` anchors against the window's CURRENT
/// frame size — so resize FIRST (establish correct dimensions), then move.
///
/// DPI correctness differs by platform:
/// - **macOS:** tao converts whatever we pass to LOGICAL points using the window's
///   CURRENT scale factor. Our rect is in the TARGET monitor's physical pixels, so
///   when the window currently lives on a different-scale display (Retina laptop
///   tiling onto a 1× external, or vice-versa) that conversion halves/doubles the
///   geometry and the window lands the wrong size and off-screen. Pre-divide by the
///   target scale and pass LOGICAL units, which tao keeps verbatim — correct no
///   matter which display the window starts on. (macOS monitor positions/sizes are
///   themselves `logical * scale`, so this round-trips exactly.)
/// - **Windows/Linux:** coordinates are physical pixels in one global space; pass
///   the rect straight through.
fn apply_tile(win: &WebviewWindow, rect: (i32, i32, u32, u32), scale: f64) {
    let (x, y, w, h) = rect;
    #[cfg(target_os = "macos")]
    {
        let s = if scale > 0.0 { scale } else { 1.0 };
        let _ = win.set_size(tauri::LogicalSize::new(w as f64 / s, h as f64 / s));
        let _ = win.set_position(tauri::LogicalPosition::new(x as f64 / s, y as f64 / s));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// Tile the first `count` VISIBLE windows into a grid filling the chosen
/// monitor's work area (`targetMonitor`, else primary).
/// Synchronous (applies all rects immediately) — used at window-creation time
/// (`setup_windows` / restore), where the OS commits each before the next shows.
pub(crate) fn arrange_windows(app: &tauri::AppHandle, count: usize) {
    arrange_these(sorted_windows(app, count), count)
}

/// Tile an EXPLICIT window list into a `count`-cell grid.
///
/// `apply_page` uses this rather than `arrange_windows` because it tiles the
/// incoming page while those windows are still hidden — there is no "visible"
/// set to select from yet, and the list it has is exactly the one it wants.
fn arrange_these(tiles: Vec<WebviewWindow>, count: usize) {
    if tiles.is_empty() {
        return;
    }
    let Some((ox, oy, w, h, scale)) = tile_area(&tiles[0]) else {
        return;
    };
    let rects = tile_rects(count, ox, oy, w, h);
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect, scale);
    }
}

pub(crate) fn label_rank(label: &str) -> (u8, u32) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("project-").and_then(|s| s.parse().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Pure: labels in reading order — rows top→bottom, left→right within a row.
/// Windows whose y differs by < `row_tolerance` from the row's anchor (first
/// member) are treated as the same row. `positions` is `(label, x, y)`.
pub(crate) fn reading_order(positions: &[(String, i32, i32)], row_tolerance: i32) -> Vec<String> {
    if positions.is_empty() {
        return Vec::new();
    }
    // Sort by y so we can walk top→bottom and group into rows.
    let mut sorted: Vec<&(String, i32, i32)> = positions.iter().collect();
    sorted.sort_by_key(|p| p.2);

    let mut rows: Vec<Vec<&(String, i32, i32)>> = Vec::new();
    for &p in &sorted {
        let need_new_row = match rows.last() {
            // Same row when the y gap to the row's anchor is within tolerance.
            Some(row) => (p.2 - row[0].2).abs() > row_tolerance,
            None => true,
        };
        if need_new_row {
            rows.push(vec![p]);
        } else {
            rows.last_mut()
                .expect("need_new_row is false only when rows is non-empty")
                .push(p);
        }
    }

    // Within each row sort left→right by x, then collect labels in order.
    let mut out = Vec::with_capacity(positions.len());
    for mut row in rows {
        row.sort_by_key(|p| p.1);
        for p in row {
            out.push(p.0.clone());
        }
    }
    out
}

/// Pure: column count for a generalized grid tiling N windows.
/// cols = ceil(sqrt(N)) → 1→1, 2→2, 3→2, 4→2, 6→3, 9→3, 12→4.
pub(crate) fn grid_cols(count: usize) -> i32 {
    if count == 0 {
        return 1;
    }
    ((count as f64).sqrt().ceil() as i32).max(1)
}

/// Every VISIBLE window's label, in reading order (rows top→bottom, left→right
/// within a row). Tolerance ≈ half the smallest window height so tiled same-row
/// windows group reliably while free-floating windows still get a stable order.
/// Off-page (hidden) windows are excluded, which is what keeps the titlebar
/// badge reading `2/6` rather than `2/12` and stops `Cmd+\`` cycling into a
/// window the user cannot see.
pub(crate) fn compute_window_order(app: &tauri::AppHandle) -> Vec<String> {
    let windows = visible_arrangeable_windows(app);
    let mut positions: Vec<(String, i32, i32)> = Vec::with_capacity(windows.len());
    let mut min_height: i32 = i32::MAX;
    for win in &windows {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let h = size.height as i32;
        if h > 0 && h < min_height {
            min_height = h;
        }
        positions.push((win.label().to_string(), pos.x, pos.y));
    }
    // Floor the tolerance so a single tiny window doesn't collapse rows together.
    let tolerance = (min_height / 2).max(40);
    reading_order(&positions, tolerance)
}

/// Broadcast the current reading order + focused label to every window so each
/// can derive its own position (e.g. "1/4") and whether it's the active window.
pub(crate) fn broadcast_window_order(app: &tauri::AppHandle) {
    let order = compute_window_order(app);
    let focused = app.state::<FocusedWindow>().0.lock_or_recover().clone();
    let payload = serde_json::json!({ "order": order, "focused": focused });
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "window-order",
            payload.clone(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- duplicate-project detection -------------------------------------
    // conflicting_windows answers "who else already has this project open?".
    // Paths below do not exist, so normalization falls back to the literal
    // PathBuf and the comparison stays deterministic on every platform.

    fn entry(
        label: &str,
        cwd: Option<&str>,
        title: Option<&str>,
    ) -> (String, Option<PathBuf>, Option<String>) {
        (
            label.into(),
            cwd.map(PathBuf::from),
            title.map(str::to_string),
        )
    }

    #[test]
    fn conflicting_windows_skips_the_calling_window() {
        let entries = vec![entry("main", Some("/p/a"), None)];
        assert!(conflicting_windows(&entries, "main", Path::new("/p/a")).is_empty());
    }

    #[test]
    fn conflicting_windows_matches_a_peer_on_the_same_path() {
        let entries = vec![
            entry("main", Some("/p/b"), None),
            entry("w2", Some("/p/a"), None),
        ];
        let hits = conflicting_windows(&entries, "main", Path::new("/p/a"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].label, "w2");
        // No custom title: fall back to the directory basename.
        assert_eq!(hits[0].title, "a");
    }

    #[test]
    fn conflicting_windows_ignores_a_different_path() {
        let entries = vec![entry("w2", Some("/p/other"), None)];
        assert!(conflicting_windows(&entries, "main", Path::new("/p/a")).is_empty());
    }

    #[test]
    fn conflicting_windows_ignores_a_window_without_a_cwd() {
        // A window still on Home has no project bound — never a conflict.
        let entries = vec![entry("w2", None, Some("Untitled"))];
        assert!(conflicting_windows(&entries, "main", Path::new("/p/a")).is_empty());
    }

    #[test]
    fn conflicting_windows_prefers_the_custom_title() {
        let entries = vec![entry("w2", Some("/p/a"), Some("Renamed"))];
        let hits = conflicting_windows(&entries, "main", Path::new("/p/a"));
        assert_eq!(hits[0].title, "Renamed");
    }

    #[test]
    fn conflicting_windows_reports_every_peer_sharing_a_path() {
        let entries = vec![
            entry("main", Some("/p/a"), None),
            entry("w2", Some("/p/a"), None),
            entry("w3", Some("/p/a"), Some("Third")),
        ];
        let mut hits = conflicting_windows(&entries, "main", Path::new("/p/a"));
        hits.sort_by(|a, b| a.label.cmp(&b.label));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].label, "w2");
        assert_eq!(hits[1].title, "Third");
    }

    #[test]
    fn whatsnew_url_only_passes_known_moods() {
        assert_eq!(
            whatsnew_url(Some("hype")),
            "index.html?whatsnew=1&mode=hype"
        );
        assert_eq!(
            whatsnew_url(Some("calm")),
            "index.html?whatsnew=1&mode=calm"
        );
        assert_eq!(
            whatsnew_url(Some("x&concept=1")),
            "index.html?whatsnew=1&mode=calm"
        );
        assert_eq!(whatsnew_url(None), "index.html?whatsnew=1&mode=calm");
    }

    #[test]
    fn window_chrome_matches_target_os() {
        let got = window_chrome();
        if cfg!(target_os = "macos") {
            assert_eq!(got, WindowChrome::MacOverlay);
        } else {
            assert_eq!(got, WindowChrome::Native);
        }
    }

    // ── reading_order + grid_cols tests ───────────────────────────────────────

    /// Helper: build a (label, x, y) position tuple.
    fn pos(label: &str, x: i32, y: i32) -> (String, i32, i32) {
        (label.to_string(), x, y)
    }

    #[test]
    fn arranger_excludes_auxiliary_windows() {
        assert!(is_arrangeable_window_label("main"));
        assert!(is_arrangeable_window_label("project-7"));
        assert!(!is_arrangeable_window_label("whatsnew"));
        assert!(!is_arrangeable_window_label("project-preview"));
    }

    #[test]
    fn reading_order_empty_is_empty() {
        assert!(reading_order(&[], 50).is_empty());
    }

    #[test]
    fn reading_order_2x2_grid_is_reading_order() {
        // Four quadrants given out of order → TL, TR, BL, BR.
        let positions = vec![
            pos("br", 500, 400),
            pos("tl", 0, 0),
            pos("tr", 500, 0),
            pos("bl", 0, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["tl", "tr", "bl", "br"]);
    }

    #[test]
    fn reading_order_single_row_left_to_right() {
        // Three same-row windows given out of order → left, center, right.
        let positions = vec![pos("c", 500, 0), pos("a", 0, 0), pos("b", 250, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn reading_order_tolerance_groups_nearby_rows() {
        // Two windows whose y differs by 30 (< tolerance 50) → same row, x order.
        let positions = vec![pos("b", 500, 30), pos("a", 0, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b"]);
    }

    #[test]
    fn reading_order_large_gap_splits_rows() {
        // y gap of 400 (> tolerance 50) → separate rows.
        let positions = vec![pos("top", 500, 0), pos("bot", 0, 400)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["top", "bot"]);
    }

    #[test]
    fn reading_order_three_rows() {
        // 3×2 grid (6 windows) → row1 L→R, row2 L→R, row3 L→R.
        let positions = vec![
            pos("c", 500, 0),
            pos("f", 500, 800),
            pos("a", 0, 0),
            pos("e", 0, 800),
            pos("d", 0, 400),
            pos("b", 500, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "c", "d", "b", "e", "f"]);
    }

    #[test]
    fn grid_cols_generalizes_any_count() {
        assert_eq!(grid_cols(0), 1); // guard against division-by-zero
        assert_eq!(grid_cols(1), 1);
        assert_eq!(grid_cols(2), 2);
        assert_eq!(grid_cols(3), 2);
        assert_eq!(grid_cols(4), 2);
        assert_eq!(grid_cols(5), 3);
        assert_eq!(grid_cols(6), 3);
        assert_eq!(grid_cols(7), 3);
        assert_eq!(grid_cols(8), 3);
        assert_eq!(grid_cols(9), 3);
        assert_eq!(grid_cols(12), 4);
    }

    // ── Window pages ─────────────────────────────────────────────────────────
    // Up to PAGE_SIZE windows are on screen at once; the rest are hidden on
    // later pages. These lock in the pure arithmetic the page switcher relies on.

    #[test]
    fn page_for_index_packs_six_per_page() {
        assert_eq!(page_for_index(0, PAGE_SIZE), 1);
        assert_eq!(page_for_index(5, PAGE_SIZE), 1); // last slot of page 1
        assert_eq!(page_for_index(6, PAGE_SIZE), 2); // first slot of page 2
        assert_eq!(page_for_index(11, PAGE_SIZE), 2); // the 12th window
        assert_eq!(page_for_index(12, PAGE_SIZE), 3);
    }

    #[test]
    fn page_for_index_survives_a_zero_page_size() {
        // Guard against a division-by-zero if PAGE_SIZE is ever mis-set.
        assert_eq!(page_for_index(3, 0), 4);
    }

    #[test]
    fn page_count_covers_partial_pages() {
        assert_eq!(page_count(0, PAGE_SIZE), 1); // no windows is still "page 1"
        assert_eq!(page_count(1, PAGE_SIZE), 1);
        assert_eq!(page_count(6, PAGE_SIZE), 1); // exactly full
        assert_eq!(page_count(7, PAGE_SIZE), 2); // one spills over
        assert_eq!(page_count(12, PAGE_SIZE), 2);
        assert_eq!(page_count(13, PAGE_SIZE), 3);
    }

    #[test]
    fn page_tile_count_matches_the_windows_actually_on_screen() {
        // The bug this guards: tiling 2 windows with a PAGE_SIZE grid would put
        // them in two sixths of the screen instead of a half each.
        assert_eq!(page_tile_count(None, 2), 2);
        assert_eq!(page_tile_count(None, 6), 6);
    }

    #[test]
    fn page_tile_count_honours_an_explicit_request() {
        // `setup_windows(4)` on an empty workspace tiles a 4-cell grid.
        assert_eq!(page_tile_count(Some(4), 4), 4);
        // …and on a single window, so "2 windows" really does give halves.
        assert_eq!(page_tile_count(Some(2), 1), 2);
    }

    #[test]
    fn page_tile_count_never_leaves_a_window_off_the_grid() {
        // Asking for fewer windows than the page already holds: every window on
        // screen still needs a cell. Tiling only `requested` of them left the
        // remainder stacked at their old size, overlapping the new grid.
        assert_eq!(page_tile_count(Some(2), 6), 6);
        assert_eq!(page_tile_count(Some(4), 6), 6);
    }

    #[test]
    fn page_tile_count_caps_at_one_page_and_never_returns_zero() {
        // A 12-window request still tiles a 6-cell grid — the rest are paged off.
        assert_eq!(page_tile_count(Some(12), 6), PAGE_SIZE);
        // 0 would divide by zero in tile_rects.
        assert_eq!(page_tile_count(Some(0), 0), 1);
        assert_eq!(page_tile_count(None, 0), 1);
    }

    #[test]
    fn closing_a_window_off_the_last_page_falls_back_to_a_real_page() {
        // 7 windows = pages 1 and 2, user on page 2. Close one: 6 windows fit on
        // page 1 alone, so page 2 stops existing. Without a fallback the six
        // survivors stay hidden behind a page that is gone and the screen is
        // empty. `Destroyed` recomputes the pages that still hold windows…
        let pages_after_close: Vec<u8> = (0..6).map(|i| page_for_index(i, PAGE_SIZE)).collect();
        assert_eq!(pages_after_close, vec![1; 6]);
        // …and falls back to page 1 rather than staying on the empty page 2.
        assert_eq!(fallback_page(&[1], 2), Some(1));
    }

    #[test]
    fn fallback_page_stays_put_while_the_page_has_windows() {
        assert_eq!(fallback_page(&[1, 2], 1), None);
    }

    #[test]
    fn fallback_page_prefers_the_nearest_lower_page() {
        // Closing the last window of page 2 drops you back to page 1.
        assert_eq!(fallback_page(&[1], 2), Some(1));
        assert_eq!(fallback_page(&[1, 2], 3), Some(2));
    }

    #[test]
    fn fallback_page_climbs_when_nothing_is_below() {
        // Emptying page 1 while page 2 still holds windows.
        assert_eq!(fallback_page(&[2, 3], 1), Some(2));
    }

    #[test]
    fn fallback_page_is_none_when_no_windows_remain() {
        assert_eq!(fallback_page(&[], 1), None);
    }

    #[test]
    fn closing_every_page_two_window_brings_page_one_back() {
        // 12 windows, user on page 2, closes 7–12. Only page 1 remains but the
        // stored page is still 2 — page 1's hidden windows must be re-shown.
        assert_eq!(repage_target(&[1], 2), Some(1));
    }

    #[test]
    fn repage_target_leaves_a_single_page_workspace_alone() {
        // Closing one of three hand-placed windows must not re-tile the rest.
        assert_eq!(repage_target(&[1], 1), None);
        assert_eq!(repage_target(&[], 1), None);
    }

    #[test]
    fn repage_target_reapplies_while_pages_are_in_play() {
        assert_eq!(repage_target(&[1, 2], 2), Some(2));
        assert_eq!(repage_target(&[1, 2], 1), Some(1));
        assert_eq!(repage_target(&[1, 2], 3), Some(2));
    }

    #[test]
    fn restore_shows_only_the_first_page_of_saved_windows() {
        // Restore derives visibility from the entry index, exactly as
        // `window_page_map` derives it from the label order afterwards — so a
        // 12-window workspace comes back as 6 visible + 6 hidden.
        let visible = (0..12)
            .filter(|i| page_for_index(*i, PAGE_SIZE) == 1)
            .count();
        assert_eq!(visible, 6);
    }

    #[test]
    fn tile_rects_fills_work_area_row_major() {
        // 1920×1080 work area, origin (0,0). 4 windows → 2×2.
        let rects = tile_rects(4, 0, 0, 1920, 1080);
        assert_eq!(rects.len(), 4);
        // Row 0: left & right halves.
        assert_eq!(rects[0], (0, 0, 960, 540));
        assert_eq!(rects[1], (960, 0, 960, 540));
        // Row 1: left & right halves.
        assert_eq!(rects[2], (0, 540, 960, 540));
        assert_eq!(rects[3], (960, 540, 960, 540));
    }

    #[test]
    fn tile_rects_five_is_three_cols_two_rows() {
        // 5 windows → cols=3, rows=2. The last two land in row 1 (col 0 & 1).
        let rects = tile_rects(5, 0, 0, 3000, 1000);
        assert_eq!(rects.len(), 5);
        let cell_w = 3000 / 3; // 1000
        let cell_h = 1000 / 2; // 500
                               // Indices 3 & 4 are the bottom row — they must be sized to the cell.
        assert_eq!(rects[3], (0, cell_h, cell_w as u32, cell_h as u32));
        assert_eq!(rects[4], (cell_w, cell_h, cell_w as u32, cell_h as u32));
    }

    #[test]
    fn tile_rects_empty_is_empty() {
        assert!(tile_rects(0, 0, 0, 1920, 1080).is_empty());
    }
}
