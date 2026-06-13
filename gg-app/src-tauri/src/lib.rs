use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use futures_util::StreamExt;
use tauri::{Emitter, Manager, State};

/// Shared handle to the spawned Node agent sidecar + the port it reported.
#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn current_port(app: &tauri::AppHandle) -> Option<u16> {
    let state: State<Sidecar> = app.state();
    let p = *state.port.lock().unwrap();
    p
}

/// Frontend polls this until it returns a port (mirrors the `sidecar-ready` event).
#[tauri::command]
fn sidecar_port(state: State<Sidecar>) -> Option<u16> {
    *state.port.lock().unwrap()
}

/// Proxy: current agent/session state.
#[tauri::command]
async fn agent_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let port = current_port(&app).ok_or("sidecar not ready")?;
    let res = reqwest::get(format!("{}/state", sidecar_base(port)))
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Proxy: submit a prompt. The reply streams back via the `agent-event` event.
#[tauri::command]
async fn agent_prompt(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let port = current_port(&app).ok_or("sidecar not ready")?;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/prompt", sidecar_base(port)))
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cancel the in-flight run.
#[tauri::command]
async fn agent_cancel(app: tauri::AppHandle) -> Result<(), String> {
    let port = current_port(&app).ok_or("sidecar not ready")?;
    let client = reqwest::Client::new();
    client
        .post(format!("{}/cancel", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Connect to the sidecar SSE stream and re-emit each frame to the webview as
/// `agent-event`. Rust has no mixed-content restriction, so the webview never
/// touches plain HTTP directly. Reconnects on stream end.
fn start_event_bridge(app: tauri::AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        loop {
            let url = format!("{}/events", sidecar_base(port));
            match reqwest::get(&url).await {
                Ok(res) => {
                    let mut stream = res.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break };
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // SSE frames are separated by a blank line.
                        while let Some(idx) = buf.find("\n\n") {
                            let frame = buf[..idx].to_string();
                            buf.drain(..idx + 2);
                            for line in frame.lines() {
                                if let Some(payload) = line.strip_prefix("data: ") {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(payload)
                                    {
                                        let _ = app.emit("agent-event", value);
                                    }
                                }
                            }
                        }
                    }
                    log::warn!("agent event stream ended, reconnecting");
                }
                Err(e) => {
                    log::error!("failed to connect to event stream: {e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

/// Resolve the built sidecar JS. Override with GG_SIDECAR_PATH; otherwise derive
/// it from the workspace layout relative to this crate.
fn sidecar_path() -> PathBuf {
    if let Ok(p) = std::env::var("GG_SIDECAR_PATH") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/ggcoder/dist/app-sidecar.js")
}

/// Working directory the agent operates in. Override with GG_APP_CWD; defaults
/// to the workspace root for now (a project picker comes later).
fn agent_cwd() -> PathBuf {
    if let Ok(p) = std::env::var("GG_APP_CWD") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn spawn_sidecar(app: tauri::AppHandle) {
    let script = sidecar_path();
    let cwd = agent_cwd();
    let node = std::env::var("GG_NODE_BIN").unwrap_or_else(|_| "node".into());
    log::info!("spawning sidecar: {} (cwd={})", script.display(), cwd.display());

    let mut cmd = Command::new(node);
    cmd.arg(&script)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake. Avoids EADDRINUSE when a prior sidecar
        // is orphaned by a dev hot-restart.
        .env("GG_APP_PORT", "0")
        .env("GG_APP_CWD", &cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::error!("failed to spawn sidecar: {e}");
            let _ = app.emit("sidecar-error", format!("failed to spawn sidecar: {e}"));
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        log::info!("sidecar listening on port {port}");
                        {
                            let state: State<Sidecar> = app2.state();
                            *state.port.lock().unwrap() = Some(port);
                        }
                        start_event_bridge(app2.clone(), port);
                        let _ = app2.emit("sidecar-ready", port);
                    }
                } else {
                    log::debug!("[sidecar] {line}");
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[sidecar:stderr] {line}");
                if line.starts_with("GG_APP_FATAL") {
                    let _ = app3.emit("sidecar-error", line);
                }
            }
        });
    }

    let state: State<Sidecar> = app.state();
    *state.child.lock().unwrap() = Some(child);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("gg-app".into()),
                    },
                ))
                .build(),
        )
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_port,
            agent_state,
            agent_prompt,
            agent_cancel
        ])
        .setup(|app| {
            spawn_sidecar(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state: State<Sidecar> = window.state();
                let child = state.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
