// ZCode mini 看板的系统托盘壳。
// 职责只有三件事：托盘图标、置顶可开关的小窗口、关窗即缩回托盘。
// 看板页面本体由桥接服务的 /mini 提供（含 token 自动获取），本壳不做任何鉴权逻辑。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 桥接端口：环境变量 BRIDGE_PORT > exe 目录向上最多 4 层找到的 bridge.config.json > 默认 8787。
/// dev 模式（cwd 在 bridge/tray/src-tauri）时 exe 在 target/debug 下，向上 3 层即 bridge/。
fn find_port() -> u16 {
    if let Ok(p) = std::env::var("BRIDGE_PORT") {
        if let Ok(n) = p.parse::<u16>() {
            return n;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|d| d.to_path_buf());
        for _ in 0..4 {
            match dir {
                Some(d) => {
                    let cfg = d.join("bridge.config.json");
                    if cfg.exists() {
                        if let Ok(txt) = std::fs::read_to_string(&cfg) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                                if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                                    if (1..=65535).contains(&p) {
                                        return p as u16;
                                    }
                                }
                            }
                        }
                    }
                    dir = d.parent().map(|p| p.to_path_buf());
                }
                None => break,
            }
        }
    }
    8787
}

fn main() {
    let port = find_port();
    let url: tauri::Url = format!("http://127.0.0.1:{port}/mini")
        .parse()
        .expect("无效的看板地址");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "mini", WebviewUrl::External(url.clone()))
                .title("ZCode mini")
                .inner_size(440.0, 720.0)
                .min_inner_size(360.0, 480.0)
                .build()?;

            let open = MenuItem::with_id(app, "open", "打开看板", true, None::<&str>)?;
            let on_top = CheckMenuItem::with_id(app, "top", "窗口置顶", true, false, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &on_top, &reload, &quit])?;

            let on_top_for_event = on_top.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("缺少图标").clone())
                .tooltip("ZCode mini 看板")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| match ev.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("mini") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "top" => {
                        if let Some(w) = app.get_webview_window("mini") {
                            let cur = w.is_always_on_top().unwrap_or(false);
                            let _ = w.set_always_on_top(!cur);
                            let _ = on_top_for_event.set_checked(!cur);
                        }
                    }
                    "reload" => {
                        if let Some(w) = app.get_webview_window("mini") {
                            let _ = w.eval("location.reload()");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    // 左键单击托盘：显示/隐藏窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("mini") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 缩回托盘，托盘菜单「退出」才是真退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("ZCode mini 托盘壳运行失败");
}
