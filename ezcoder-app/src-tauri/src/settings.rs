//! Native app settings (~/.ezcoder/ezcoder-app.json) and the workspace snapshot.

use crate::*;

// ── Native app settings (~/.ezcoder/ezcoder-app.json) ───────────────────────
// The project folder is a plain home-dir file with NOTHING to do with the
// agent, so Rust reads/writes it directly. This makes the home-screen Settings
// + New project flow independent of the Node sidecar's boot — a slow or crashed
// sidecar used to make "Save project folder" silently fail or time out even on
// up-to-date builds. (The sidecar keeps its own /settings endpoint for its
// internal use; this is the authoritative path for the webview.)

/// Absolute path to ~/.ezcoder/ezcoder-app.json.
pub(crate) fn app_settings_path() -> PathBuf {
    home_dir().join(".ezcoder").join("ezcoder-app.json")
}

/// Default projects root: ~/ez-projects.
pub(crate) fn default_projects_root() -> PathBuf {
    home_dir().join("ez-projects")
}

/// Validate a project folder name: lowercase letters, digits, single dashes
/// between segments (mirrors the sidecar's isValidProjectName).
pub(crate) fn is_valid_project_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ — no leading/trailing/double dashes.
    let bytes = name.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_dash = false;
    for &b in bytes {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => prev_dash = false,
            b'-' => {
                if prev_dash {
                    return false;
                }
                prev_dash = true;
            }
            _ => return false,
        }
    }
    true
}

/// Native: read ezcoder-app settings directly from ~/.ezcoder/ezcoder-app.json. `configured`
/// is true only when the file exists with a non-empty projectsRoot (so the home
/// screen's "Your Projects" gate matches the sidecar's semantics). Never needs
/// the sidecar.
#[tauri::command]
pub(crate) fn app_settings_get() -> serde_json::Value {
    let raw = std::fs::read_to_string(app_settings_path()).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let configured = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let projects_root = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_projects_root().to_string_lossy().to_string());
    // The display the window tiler should fill (by monitor label). Absent/empty
    // means "auto" — an external display first (see `choose_monitor`).
    let target_monitor = parsed
        .as_ref()
        .and_then(|v| v.get("targetMonitor"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    serde_json::json!({
        "projectsRoot": projects_root,
        "configured": configured,
        "targetMonitor": target_monitor,
    })
}

/// The display label the window tiler should fill, from ~/.ezcoder/ezcoder-app.json.
/// `None` means "auto" (external display first).
pub(crate) fn target_monitor_name() -> Option<String> {
    app_settings_get()
        .get("targetMonitor")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

/// Merge `patch` into ~/.ezcoder/ezcoder-app.json (a JSON object), preserving every
/// other key. A `null` value in `patch` removes that key. Creates the directory
/// and file as needed. Returns the full merged object.
fn write_app_settings(patch: serde_json::Value) -> Result<serde_json::Value, String> {
    let path = app_settings_path();
    let mut current = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            if v.is_null() {
                current.remove(k);
            } else {
                current.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let value = serde_json::Value::Object(current);
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(value)
}

/// Native: write ezcoder-app settings directly to ~/.ezcoder/ezcoder-app.json. Creates the
/// ~/.ezcoder directory if needed. Never needs the sidecar.
#[tauri::command]
pub(crate) fn app_settings_save(projects_root: String) -> Result<serde_json::Value, String> {
    let trimmed = projects_root.trim();
    if trimmed.is_empty() {
        return Err("projectsRoot is required".to_string());
    }
    // Merge so a previously-chosen targetMonitor isn't wiped by saving the folder.
    write_app_settings(serde_json::json!({ "projectsRoot": trimmed }))?;
    Ok(serde_json::json!({ "projectsRoot": trimmed }))
}

/// Stable identity for a monitor — its physical top-left position — used as both
/// the persisted `targetMonitor` key and the value `tile_area` matches against.
/// Position is unique per display and survives replug/rearrange, unlike the OS
/// `name()` (macOS returns a model number that COLLIDES across two identical
/// external displays; the old index-based fallback shifted when a monitor was
/// unplugged, silently re-pointing the saved choice at a different screen).
fn monitor_key(monitor: &tauri::Monitor) -> String {
    let p = monitor.position();
    format!("{},{}", p.x, p.y)
}

/// Human-readable label for the picker. Primary → "Primary"; others are described
/// by their direction from the primary ("Left"/"Right"/"Above"/"Below"), which
/// disambiguates two identical displays far better than a raw model number. Falls
/// back to a 1-based index only when no primary position is known.
fn monitor_friendly_label(
    monitor: &tauri::Monitor,
    index: usize,
    primary_pos: Option<&tauri::PhysicalPosition<i32>>,
    builtin: bool,
) -> String {
    if builtin {
        return "Built-in".to_string();
    }
    let pos = monitor.position();
    if primary_pos == Some(pos) {
        return "Primary".to_string();
    }
    if let Some(pp) = primary_pos {
        let dx = pos.x - pp.x;
        let dy = pos.y - pp.y;
        if dx != 0 || dy != 0 {
            let dir = if dx.abs() >= dy.abs() {
                if dx < 0 {
                    "Left"
                } else {
                    "Right"
                }
            } else if dy < 0 {
                "Above"
            } else {
                "Below"
            };
            return dir.to_string();
        }
    }
    format!("Display {}", index + 1)
}

/// A CoreGraphics rect, laid out exactly as `CGRect` (two f64 pairs).
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayIsBuiltin(display: u32) -> u32;
    fn CGDisplayBounds(display: u32) -> CgRect;
}

/// Logical (point) origins of the built-in laptop panels currently active.
/// Tauri's `Monitor` carries no "built-in" flag, so we ask CoreGraphics and
/// match by origin (tao derives `Monitor::position` from the same
/// `CGDisplayBounds`, scaled to physical pixels).
#[cfg(target_os = "macos")]
fn builtin_display_origins() -> Vec<(f64, f64)> {
    const MAX: usize = 16;
    let mut ids = [0u32; MAX];
    let mut count = 0u32;
    // SAFETY: `ids` has room for MAX entries and CoreGraphics writes at most
    // `max` of them, reporting how many in `count`.
    let err = unsafe { CGGetActiveDisplayList(MAX as u32, ids.as_mut_ptr(), &mut count) };
    if err != 0 {
        return Vec::new();
    }
    ids.iter()
        .take((count as usize).min(MAX))
        // SAFETY: plain value-in/value-out CoreGraphics queries on live ids.
        .filter(|id| unsafe { CGDisplayIsBuiltin(**id) } != 0)
        .map(|id| {
            let b = unsafe { CGDisplayBounds(*id) };
            (b.x, b.y)
        })
        .collect()
}

/// Built-in detection needs OS display-connector APIs we don't bind outside
/// macOS; there every monitor counts as external, so auto keeps the OS primary.
#[cfg(not(target_os = "macos"))]
fn builtin_display_origins() -> Vec<(f64, f64)> {
    Vec::new()
}

/// The facts `choose_monitor` decides on, one per connected display.
pub(crate) struct MonitorFacts {
    key: String,
    primary: bool,
    builtin: bool,
    /// Logical (point) area — physical area undersells a 1× external next to a
    /// Retina laptop panel.
    logical_area: f64,
}

pub(crate) fn monitor_facts(win: &WebviewWindow) -> Vec<(tauri::Monitor, MonitorFacts)> {
    let monitors = win.available_monitors().unwrap_or_default();
    let primary_pos = win.primary_monitor().ok().flatten().map(|m| *m.position());
    let builtins = builtin_display_origins();
    monitors
        .into_iter()
        .map(|m| {
            let scale = if m.scale_factor() > 0.0 {
                m.scale_factor()
            } else {
                1.0
            };
            let pos = *m.position();
            let (lx, ly) = (pos.x as f64 / scale, pos.y as f64 / scale);
            let builtin = builtins
                .iter()
                .any(|(bx, by)| (bx - lx).abs() < 1.5 && (by - ly).abs() < 1.5);
            let size = m.size();
            let facts = MonitorFacts {
                key: monitor_key(&m),
                primary: primary_pos == Some(pos),
                builtin,
                logical_area: (size.width as f64 / scale) * (size.height as f64 / scale),
            };
            (m, facts)
        })
        .collect()
}

/// Pure: which display the tiler fills.
///
/// 1. The saved choice, when that display is still connected.
/// 2. Otherwise "auto": an external display always beats the built-in laptop
///    panel — the OS primary if it is external, else the largest external.
/// 3. With no external connected, the primary (else the first display).
///
/// A saved choice that no longer matches (positions shift when a display is
/// replugged or rearranged) falls to auto, i.e. the external — never silently
/// to the laptop screen.
pub(crate) fn choose_monitor(monitors: &[MonitorFacts], want: Option<&str>) -> Option<usize> {
    if let Some(i) = want.and_then(|key| monitors.iter().position(|m| m.key == key)) {
        return Some(i);
    }
    let externals = monitors.iter().enumerate().filter(|(_, m)| !m.builtin);
    let best_external = externals.fold(None::<(usize, &MonitorFacts)>, |best, (i, m)| match best {
        None => Some((i, m)),
        Some((_, b)) if (m.primary, m.logical_area) > (b.primary, b.logical_area) => Some((i, m)),
        keep => keep,
    });
    best_external
        .map(|(i, _)| i)
        .or_else(|| monitors.iter().position(|m| m.primary))
        .or(if monitors.is_empty() { None } else { Some(0) })
}

/// Native: enumerate the connected displays so the webview can offer a "tile onto
/// this monitor" picker. `selected` echoes the saved targetMonitor, or null (auto)
/// when that display isn't connected any more — so the picker never shows a
/// choice the tiler has stopped honouring. Never needs the sidecar.
#[tauri::command]
pub(crate) fn list_monitors(window: WebviewWindow) -> Result<serde_json::Value, String> {
    let monitors = monitor_facts(&window);
    // Identify the primary by position (unique per display) rather than by label,
    // since the index-based fallback label only lines up when the primary is first.
    let primary_pos = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| *m.position());
    let selected = target_monitor_name().filter(|key| monitors.iter().any(|(_, f)| &f.key == key));
    let list: Vec<serde_json::Value> = monitors
        .iter()
        .enumerate()
        .map(|(i, (m, facts))| {
            // `name` is the stable matching/persistence key; `label` is what the
            // user actually reads in the picker.
            let label = monitor_friendly_label(m, i, primary_pos.as_ref(), facts.builtin);
            let size = m.size();
            let pos = m.position();
            let is_selected = selected.as_deref() == Some(facts.key.as_str());
            serde_json::json!({
                "name": facts.key,
                "label": label,
                "width": size.width,
                "height": size.height,
                "x": pos.x,
                "y": pos.y,
                "primary": facts.primary,
                "builtin": facts.builtin,
                "selected": is_selected,
            })
        })
        .collect();
    Ok(serde_json::json!({ "monitors": list, "selected": selected }))
}

/// Native: persist which display the window tiler should fill. `None`/empty clears
/// the choice (back to auto = external first). Merges into ezcoder-app.json so the
/// projects root is preserved. Never needs the sidecar.
#[tauri::command]
pub(crate) fn app_set_target_monitor(monitor: Option<String>) -> Result<serde_json::Value, String> {
    let value = monitor
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    let patch = match &value {
        Some(name) => serde_json::json!({ "targetMonitor": name }),
        None => serde_json::json!({ "targetMonitor": serde_json::Value::Null }),
    };
    write_app_settings(patch)?;
    Ok(serde_json::json!({ "targetMonitor": value }))
}

/// Native: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, an error message on invalid name / conflict.
/// Never needs the sidecar.
#[tauri::command]
pub(crate) fn app_create_project(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if !is_valid_project_name(name) {
        return Err(
            "Project name must be lowercase letters, digits, and dashes (e.g. my-project)."
                .to_string(),
        );
    }
    // Resolve the projects root the same way app_settings_get does.
    let settings = app_settings_get();
    let root = settings
        .get("projectsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_root);
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("A folder named \"{name}\" already exists."));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
}

// ── Workspace snapshot (~/.ezcoder/ezcoder-app-workspace.json) ──────────────────────
// Records which project/session is open in each window (plus geometry) so a
// restart — especially the updater's relaunch() — can reopen every window where
// it left off instead of dropping back to a single picker window. Owned by Rust
// (same pattern as ezcoder-app.json), written on project-select / window-close /
// app-exit, replayed in `setup`.

/// One saved window: its mode, cwd, an optional session file to resume, and
/// optional last-known geometry (physical pixels).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WorkspaceEntry {
    #[serde(default)]
    pub(crate) mode: WorkspaceMode,
    #[serde(rename = "chatAgent", default)]
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: String,
    #[serde(
        rename = "sessionPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) session_path: Option<String>,
    #[serde(
        rename = "customTitle",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
}

/// The whole snapshot: an ordered list of open windows (main first).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Workspace {
    #[serde(default)]
    pub(crate) windows: Vec<WorkspaceEntry>,
}

/// Absolute path to ~/.ezcoder/ezcoder-app-workspace.json.
pub(crate) fn app_workspace_path() -> PathBuf {
    home_dir()
        .join(".ezcoder")
        .join("ezcoder-app-workspace.json")
}

/// Read the workspace snapshot; missing/invalid file → an empty workspace.
pub(crate) fn read_workspace() -> Workspace {
    std::fs::read_to_string(app_workspace_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Workspace>(&s).ok())
        .unwrap_or_default()
}

/// Write the workspace snapshot (creating ~/.ezcoder if needed). Best-effort.
pub(crate) fn write_workspace(ws: &Workspace) {
    let path = app_workspace_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(ws) {
        let _ = std::fs::write(&path, pretty);
    }
}

/// Pure: picker-only windows have a daemon session at the default boot cwd but
/// no active workspace target. A selected project remains snapshot-worthy even
/// when its path happens to equal that default cwd.
pub(crate) fn keep_for_snapshot(workspace_selected: bool, cwd: Option<&Path>) -> bool {
    workspace_selected && cwd.is_some()
}

/// Pure: drop restore entries that can't be opened (empty cwd, or a cwd that no
/// longer exists). `exists` is injected so this is testable without the fs.
pub(crate) fn filter_restorable<F: Fn(&str) -> bool>(
    windows: Vec<WorkspaceEntry>,
    exists: F,
) -> Vec<WorkspaceEntry> {
    windows
        .into_iter()
        .filter(|w| !w.cwd.trim().is_empty() && exists(&w.cwd))
        .collect()
}

/// Walk every live window + its `Windows` session entry and write a fresh
/// snapshot. Picker-only windows (without an active target) are excluded.
/// Geometry is captured from each window's current outer position + inner size.
pub(crate) fn snapshot_workspace(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    let selected_labels: HashSet<String> = app
        .state::<RestoreTargets>()
        .map
        .lock_or_recover()
        .keys()
        .cloned()
        .collect();
    let state: State<Windows> = app.state();
    let map = state.map.lock_or_recover();

    // Deterministic order: main first, then project-N ascending, so the first
    // restored window reclaims the `main` label.
    let mut labels: Vec<String> = windows.keys().cloned().collect();
    labels.sort_by_key(|a| label_rank(a));

    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    for label in &labels {
        let Some(inst) = map.get(label) else { continue };
        let cwd = inst.cwd.as_deref();
        if !keep_for_snapshot(selected_labels.contains(label), cwd) {
            continue;
        }
        let cwd = cwd
            .expect("keep_for_snapshot returned true, so cwd is Some")
            .to_string_lossy()
            .to_string();
        let (mut x, mut y, mut width, mut height) = (None, None, None, None);
        if let Some(win) = windows.get(label) {
            if let Ok(pos) = win.outer_position() {
                x = Some(pos.x);
                y = Some(pos.y);
            }
            if let Ok(size) = win.inner_size() {
                width = Some(size.width);
                height = Some(size.height);
            }
        }
        entries.push(WorkspaceEntry {
            mode: inst.mode,
            chat_agent: inst.chat_agent,
            cwd,
            session_path: inst.session_path.clone(),
            custom_title: inst.custom_title.clone(),
            x,
            y,
            width,
            height,
        });
    }
    drop(map);
    write_workspace(&Workspace { windows: entries });
}

/// Remove one window's entry from the snapshot after a deliberate close. The
/// custom title disambiguates duplicate windows on the same project so closing
/// one cannot transfer another window's saved name on the next launch.
pub(crate) fn remove_window_from_workspace(app: &tauri::AppHandle, label: &str) {
    let target = {
        let state: State<Windows> = app.state();
        let map = state.map.lock_or_recover();
        map.get(label).and_then(|window| {
            window.cwd.as_ref().map(|cwd| {
                (
                    window.mode,
                    window.chat_agent,
                    cwd.to_string_lossy().to_string(),
                    window.custom_title.clone(),
                )
            })
        })
    };
    let Some((mode, chat_agent, cwd, custom_title)) = target else {
        return;
    };
    let mut ws = read_workspace();
    // Remove one exact identity. Identically named duplicate windows are
    // interchangeable; differently named duplicates must remain independent.
    if let Some(idx) = ws.windows.iter().position(|window| {
        window.mode == mode
            && window.chat_agent == chat_agent
            && window.cwd == cwd
            && window.custom_title == custom_title
    }) {
        ws.windows.remove(idx);
        write_workspace(&ws);
    }
}

/// Hand the calling webview its active workspace target so it can skip Home and
/// hydrate the existing daemon session. Unlike the old consume-once target, this
/// remains available across React remounts and WebKit content-process reloads.
#[tauri::command]
pub(crate) fn window_restore_target(webview: WebviewWindow) -> Option<RestoreEntry> {
    let state: State<RestoreTargets> = webview.state();
    let map = state.map.lock_or_recover();
    restore_target(&map, webview.label())
}

fn normalize_window_title(title: Option<String>) -> Option<String> {
    let trimmed = title?.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(80).collect())
}

/// Return THIS window's persisted custom label. None means use the project name.
#[tauri::command]
pub(crate) fn window_title_get(webview: WebviewWindow) -> Option<String> {
    let saved = webview
        .state::<Windows>()
        .map
        .lock()
        .unwrap()
        .get(webview.label())
        .and_then(|window| window.custom_title.clone());
    if saved.is_some() {
        return saved;
    }
    webview
        .state::<RestoreTargets>()
        .map
        .lock()
        .unwrap()
        .get(webview.label())
        .and_then(|target| target.custom_title.clone())
}

/// Save THIS window's custom label into the same snapshot that restores its workspace.
#[tauri::command]
pub(crate) fn window_title_set(
    webview: WebviewWindow,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let title = normalize_window_title(title);
    {
        let windows: State<Windows> = webview.state();
        let mut map = windows.map.lock().unwrap();
        let window = map
            .get_mut(webview.label())
            .ok_or_else(|| "window session is not ready".to_string())?;
        window.custom_title = title.clone();
    }
    if let Some(target) = webview
        .state::<RestoreTargets>()
        .map
        .lock()
        .unwrap()
        .get_mut(webview.label())
    {
        target.custom_title = title.clone();
    }
    snapshot_workspace(webview.app_handle());
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(key: &str, primary: bool, builtin: bool, area: f64) -> MonitorFacts {
        MonitorFacts {
            key: key.to_string(),
            primary,
            builtin,
            logical_area: area,
        }
    }

    #[test]
    fn auto_prefers_an_external_over_a_primary_laptop_panel() {
        let laptop = facts("0,0", true, true, 1512.0 * 982.0);
        let external = facts("-1920,-1080", false, false, 1920.0 * 1080.0);
        assert_eq!(choose_monitor(&[laptop, external], None), Some(1));
    }

    #[test]
    fn auto_uses_the_largest_external_when_none_is_primary() {
        let monitors = [
            facts("0,0", true, true, 1512.0 * 982.0),
            facts("a", false, false, 1920.0 * 1080.0),
            facts("b", false, false, 2560.0 * 1440.0),
        ];
        assert_eq!(choose_monitor(&monitors, None), Some(2));
    }

    #[test]
    fn auto_keeps_a_primary_external_and_falls_to_the_laptop_alone() {
        let monitors = [
            facts("a", false, false, 2560.0 * 1440.0),
            facts("b", true, false, 1920.0 * 1080.0),
        ];
        assert_eq!(choose_monitor(&monitors, None), Some(1));
        assert_eq!(
            choose_monitor(&[facts("0,0", true, true, 1.0)], None),
            Some(0)
        );
        assert_eq!(choose_monitor(&[], None), None);
    }

    #[test]
    fn saved_choice_wins_but_a_stale_one_falls_to_the_external() {
        let monitors = [
            facts("0,0", true, true, 1512.0 * 982.0),
            facts("-1920,-1080", false, false, 1920.0 * 1080.0),
        ];
        assert_eq!(choose_monitor(&monitors, Some("0,0")), Some(0));
        // The display moved (replug/rearrange): never silently the laptop.
        assert_eq!(choose_monitor(&monitors, Some("-3840,0")), Some(1));
    }

    #[test]
    fn keep_for_snapshot_excludes_only_unselected_picker_windows() {
        let default = Path::new("/home/user");
        // Picker session exists at the boot cwd, but no workspace was chosen.
        assert!(!keep_for_snapshot(false, Some(default)));
        assert!(!keep_for_snapshot(false, None));
        // Explicitly choosing that exact directory must still survive restart.
        assert!(keep_for_snapshot(true, Some(default)));
        assert!(keep_for_snapshot(true, Some(Path::new("/home/user/proj"))));
    }

    #[test]
    fn filter_restorable_drops_missing_and_empty() {
        let windows = vec![
            WorkspaceEntry {
                cwd: "/exists/a".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "   ".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "/gone/b".into(),
                ..Default::default()
            },
        ];
        let kept = filter_restorable(windows, |c| c == "/exists/a");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].cwd, "/exists/a");
    }

    #[test]
    fn workspace_roundtrips_through_json() {
        let ws = Workspace {
            windows: vec![
                WorkspaceEntry {
                    mode: WorkspaceMode::Chat,
                    chat_agent: ChatAgent::Research,
                    cwd: "/p/a".into(),
                    session_path: Some("/s/a.jsonl".into()),
                    custom_title: Some("Auth cleanup".into()),
                    x: Some(0),
                    y: Some(25),
                    width: Some(1280),
                    height: Some(800),
                },
                WorkspaceEntry {
                    cwd: "/p/b".into(),
                    ..Default::default()
                },
            ],
        };
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(ws, back);
        assert_eq!(back.windows[0].mode, WorkspaceMode::Chat);
        assert_eq!(back.windows[0].chat_agent, ChatAgent::Research);
        assert!(json.contains(r#""mode":"chat""#));
        assert!(json.contains(r#""chatAgent":"research""#));
        assert!(json.contains(r#""customTitle":"Auth cleanup""#));
        // The second entry omits optional fields entirely (skip_serializing_if).
        assert!(!json.contains("\"sessionPath\":null"));
        assert!(!json.contains("\"customTitle\":null"));
    }

    #[test]
    fn workspace_defaults_legacy_and_invalid_modes_to_code() {
        let legacy: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "cwd": "/p/a" }] }"#).unwrap();
        assert_eq!(legacy.windows[0].mode, WorkspaceMode::Code);
        assert_eq!(legacy.windows[0].chat_agent, ChatAgent::General);

        let invalid: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "future", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(invalid.windows[0].mode, WorkspaceMode::Code);
    }

    #[test]
    fn workspace_restores_motion_mode() {
        let motion: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "motion", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(motion.windows[0].mode, WorkspaceMode::Motion);
        assert!(serde_json::to_string(&motion)
            .unwrap()
            .contains(r#""mode":"motion""#));
    }

    #[test]
    fn restore_target_serializes_mode_and_session_path() {
        let target = RestoreEntry {
            mode: WorkspaceMode::Chat,
            chat_agent: ChatAgent::Therapist,
            cwd: "/p/a".into(),
            session_path: Some("/s/a.jsonl".into()),
            custom_title: Some("Auth cleanup".into()),
        };
        let json = serde_json::to_value(target).unwrap();
        assert_eq!(json["mode"], "chat");
        assert_eq!(json["chatAgent"], "therapist");
        assert_eq!(json["cwd"], "/p/a");
        assert_eq!(json["sessionPath"], "/s/a.jsonl");
        assert_eq!(json["customTitle"], "Auth cleanup");
    }

    #[test]
    fn window_title_normalization_trims_resets_and_limits_length() {
        assert_eq!(
            normalize_window_title(Some("  Auth cleanup  ".into())).as_deref(),
            Some("Auth cleanup")
        );
        assert_eq!(normalize_window_title(Some("   ".into())), None);
        assert_eq!(
            normalize_window_title(Some("x".repeat(100)))
                .unwrap()
                .chars()
                .count(),
            80
        );
    }

    #[test]
    fn empty_or_missing_workspace_is_default() {
        let ws: Workspace = serde_json::from_str("{}").unwrap();
        assert!(ws.windows.is_empty());
    }
}
