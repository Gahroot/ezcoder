//! Machines panel and fleet activity (PRD 8.5, D1–D5): one proxy for the
//! sidecar's `/fleet/*` routes (packages/cli/src/app-sidecar/fleet-routes.ts).

use crate::commands::agent::sidecar_json;
use crate::*;

/// The sidecar routes this proxy may reach, with their HTTP method.
const FLEET_ROUTES: &[(&str, &str)] = &[
    ("GET", "/fleet/machines"),
    ("GET", "/fleet/activity"),
    ("POST", "/fleet/machines/add"),
    ("POST", "/fleet/machines/remove"),
    ("POST", "/fleet/machines/rotate-token"),
    ("POST", "/fleet/machines/share-auth"),
    ("POST", "/fleet/machines/doctor"),
    ("POST", "/fleet/log"),
];

fn allowed(method: &str, path: &str) -> bool {
    FLEET_ROUTES.iter().any(|(m, p)| *m == method && *p == path)
}

/// Proxy: one fleet call. `path` must be one of `FLEET_ROUTES`.
#[tauri::command]
pub(crate) async fn agent_fleet(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !allowed(&method, &path) {
        return Err(format!("unknown fleet route {method} {path}"));
    }
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let ez_sid = session_for(&webview).ok_or("session not ready")?;
    let url = format!("{}{}", sidecar_base(port), path);
    let req = if method == "GET" {
        client.get(url)
    } else {
        client
            .post(url)
            .json(&body.unwrap_or_else(|| serde_json::json!({})))
    };
    let res = req
        .header("x-ez-session", &ez_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn only_listed_fleet_routes_pass() {
        assert!(allowed("GET", "/fleet/machines"));
        assert!(allowed("POST", "/fleet/machines/add"));
        assert!(!allowed("POST", "/fleet/machines"));
        assert!(!allowed("GET", "/state"));
        assert!(!allowed("POST", "/fleet/../prompt"));
    }
}
