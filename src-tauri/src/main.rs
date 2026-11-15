#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin native shell: spawns the Node SEA sidecar (`deckseb sidecar`), waits for its
//! `{"event":"ready","url":...}` line and points the window at that loopback URL. All viewer
//! logic lives in the TypeScript server, so the CLI and the desktop app never diverge.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_BIN: &str = "deckseb-server";
const READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    exiting: AtomicBool,
}

/// Origins the window may navigate to; anything else opens in the system browser.
#[derive(Default)]
struct AllowedOrigins {
    shell: OnceLock<Url>,
    server: OnceLock<Url>,
}

#[derive(Deserialize)]
struct ReadyEvent {
    event: String,
    url: String,
}

fn parse_ready(line: &[u8]) -> Option<Url> {
    let ready: ReadyEvent = serde_json::from_slice(line.trim_ascii()).ok()?;
    if ready.event != "ready" {
        return None;
    }
    let url = Url::parse(&ready.url).ok()?;
    // Only ever load the loopback server we spawned; never a remote origin from stdout.
    let loopback = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    loopback.then_some(url)
}

// `Url::origin()` is opaque (never equal) for custom schemes like `tauri://`, so compare by parts.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_allowed(url: &Url, allowed: &AllowedOrigins) -> bool {
    match allowed.shell.get() {
        // The very first navigation (the bundled loading page) happens before we record it.
        None => true,
        Some(shell) if same_origin(url, shell) => true,
        Some(_) => allowed.server.get().is_some_and(|server| same_origin(url, server)),
    }
}

fn show_error(window: &WebviewWindow, allowed: &AllowedOrigins, message: &str) {
    eprintln!("[deckseb-desktop] {message}");
    let Some(mut page) = allowed.shell.get().cloned() else {
        return;
    };
    page.query_pairs_mut().clear().append_pair("error", message);
    let _ = window.navigate(page);
}

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.exiting.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().ok().and_then(|mut guard| guard.take()) {
        let _ = child.kill();
    }
}

fn start_sidecar(app: &AppHandle, window: WebviewWindow, allowed: Arc<AllowedOrigins>) {
    let spawned = app
        .shell()
        .sidecar(SIDECAR_BIN)
        .and_then(|command| command.args(["sidecar"]).spawn());

    let (mut events, child) = match spawned {
        Ok(pair) => pair,
        Err(err) => {
            show_error(&window, &allowed, &format!("No se pudo lanzar {SIDECAR_BIN}: {err}"));
            return;
        }
    };
    if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
        *guard = Some(child);
    }

    {
        let app = app.clone();
        let window = window.clone();
        let allowed = allowed.clone();
        std::thread::spawn(move || {
            std::thread::sleep(READY_TIMEOUT);
            if allowed.server.get().is_none() && !app.state::<SidecarState>().exiting.load(Ordering::SeqCst) {
                show_error(
                    &window,
                    &allowed,
                    &format!("El servidor no respondió en {} s.", READY_TIMEOUT.as_secs()),
                );
                kill_sidecar(&app);
            }
        });
    }

    let app = app.clone();
    // Drain every event, even after `ready`, so the sidecar never blocks on a full stdout pipe.
    tauri::async_runtime::spawn(async move {
        let mut last_stderr = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) if allowed.server.get().is_none() => {
                    if let Some(url) = parse_ready(&line) {
                        let _ = allowed.server.set(url.clone());
                        if let Err(err) = window.navigate(url) {
                            show_error(&window, &allowed, &format!("No se pudo abrir el visor: {err}"));
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    last_stderr = String::from_utf8_lossy(&line).trim().to_string();
                    eprintln!("[deckseb-server] {last_stderr}");
                }
                CommandEvent::Terminated(payload) => {
                    if !app.state::<SidecarState>().exiting.load(Ordering::SeqCst) {
                        let code = payload.code.map_or_else(|| "señal".to_string(), |c| c.to_string());
                        show_error(
                            &window,
                            &allowed,
                            &format!("El servidor se detuvo (código {code}).\n{last_stderr}"),
                        );
                    }
                    break;
                }
                CommandEvent::Error(err) => eprintln!("[deckseb-server] {err}"),
                _ => {}
            }
        }
    });
}

fn main() {
    // WebKitGTK's DMA-BUF renderer aborts with "Error 71 (Protocol error)" on Wayland with NVIDIA
    // drivers (reproduced on Hyprland + RTX 2060). Must run before any thread is spawned.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::default())
        .setup(|app| {
            let allowed = Arc::new(AllowedOrigins::default());
            let opener = app.handle().clone();
            let nav_allowed = allowed.clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("deckseb")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 480.0)
                .on_navigation(move |url| {
                    if is_allowed(url, &nav_allowed) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;

            let _ = allowed.shell.set(window.url()?);
            start_sidecar(app.handle(), window, allowed);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the deckseb desktop app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            kill_sidecar(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_ready_line() {
        let url = parse_ready(br#"{"event":"ready","url":"http://127.0.0.1:41234","port":41234,"pid":1}"#);
        assert_eq!(url.unwrap().as_str(), "http://127.0.0.1:41234/");
    }

    #[test]
    fn rejects_non_loopback_or_malformed_lines() {
        assert!(parse_ready(br#"{"event":"ready","url":"https://evil.example"}"#).is_none());
        assert!(parse_ready(br#"{"event":"ready","url":"http://0.0.0.0:80"}"#).is_none());
        assert!(parse_ready(br#"{"event":"log","url":"http://127.0.0.1:1"}"#).is_none());
        assert!(parse_ready(b"plain log line").is_none());
    }

    #[test]
    fn navigation_is_limited_to_shell_and_server_origins() {
        let allowed = AllowedOrigins::default();
        let shell = Url::parse("tauri://localhost/index.html").unwrap();
        assert!(is_allowed(&shell, &allowed), "initial load is allowed");

        allowed.shell.set(shell.clone()).unwrap();
        let server = Url::parse("http://127.0.0.1:5555/").unwrap();
        assert!(!is_allowed(&server, &allowed), "server is unknown until ready");

        allowed.server.set(server.clone()).unwrap();
        assert!(is_allowed(&Url::parse("http://127.0.0.1:5555/api/plans").unwrap(), &allowed));
        assert!(is_allowed(&Url::parse("tauri://localhost/index.html?error=x").unwrap(), &allowed));
        assert!(!is_allowed(&Url::parse("http://127.0.0.1:6666/").unwrap(), &allowed));
        assert!(!is_allowed(&Url::parse("https://github.com/").unwrap(), &allowed));
    }
}
