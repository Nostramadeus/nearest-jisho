// Desktop shell for Nearest Jisho (packaging/PLAN.md section 3b).
// Serves the bundled web files (resource folder `web`) on 127.0.0.1 and shows them in one window.
// The fixed port keeps the page origin stable, so settings, recent searches and downloaded data updates
// (all stored per origin) survive restarts. No Tauri commands, no IPC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::path::BaseDirectory;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tiny_http::{Header, Method, Request, Response, Server};

const FIRST_PORT: u16 = 47831;
const LAST_PORT: u16 = 47840;

// Links to other origins: turn the click into a plain navigation, which on_navigation below sends to the
// system browser (also covers target="_blank", which would otherwise open a new window).
const LINK_SCRIPT: &str = r#"
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  var u;
  try { u = new URL(a.href, location.href); } catch (_) { return; }
  if (u.origin === location.origin) return;
  e.preventDefault();
  window.location.href = u.href;
}, true);
"#;

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Maps a request path to a file under root. None = the path tries to leave root.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains('\\') || seg.contains(':') || seg.contains('\0') {
            return None;
        }
        path.push(seg);
    }
    Some(path)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn respond(req: Request, root: &Path) {
    if !matches!(req.method(), Method::Get | Method::Head) {
        let _ = req.respond(Response::empty(405).with_header(header("Allow", "GET, HEAD")));
        return;
    }
    let raw = req.url().split(['?', '#']).next().unwrap_or("/").to_string();
    let Some(mut rel) = percent_decode(&raw) else {
        let _ = req.respond(Response::empty(400));
        return;
    };
    if rel.ends_with('/') {
        rel.push_str("index.html");
    }
    let Some(file) = resolve(root, &rel) else {
        let _ = req.respond(Response::empty(403));
        return;
    };
    let opened = std::fs::metadata(&file)
        .ok()
        .filter(|m| m.is_file())
        .and_then(|_| File::open(&file).ok());
    let Some(f) = opened else {
        let _ = req.respond(Response::from_string("not found").with_status_code(404));
        return;
    };
    let resp = Response::from_file(f)
        .with_header(header("Content-Type", content_type(&file)))
        .with_header(header("Cache-Control", "no-cache"))
        .with_chunked_threshold(usize::MAX);
    let _ = req.respond(resp);
}

fn bind() -> Result<(Server, u16), String> {
    let mut last = String::new();
    for port in FIRST_PORT..=LAST_PORT {
        match Server::http(("127.0.0.1", port)) {
            Ok(server) => return Ok((server, port)),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("no free port in {FIRST_PORT}..{LAST_PORT}: {last}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = Arc::new(app.path().resolve("web", BaseDirectory::Resource)?);
            let (server, port) = bind()?;
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
                    let root = Arc::clone(&root);
                    std::thread::spawn(move || respond(req, &root));
                }
            });

            let origin = format!("http://127.0.0.1:{port}");
            let start: Url = format!("{origin}/").parse()?;
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
                .title("Nearest Jisho")
                .inner_size(1100.0, 800.0)
                .min_inner_size(360.0, 480.0)
                .initialization_script(LINK_SCRIPT)
                .on_navigation(move |url: &Url| {
                    if url.origin().ascii_serialization() == origin || url.as_str() == "about:blank" {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nearest Jisho");
}
