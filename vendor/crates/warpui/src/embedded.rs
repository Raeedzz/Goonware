//! Embedded-surface entry points for hosting a warpui render surface
//! inside another application's native window (e.g. a Tauri `NSWindow`),
//! driven by the host's run loop instead of warpui's own `App::run`.
//!
//! Used by Goonware's native-terminal migration: warpui renders the
//! terminal into a Metal-backed `NSView` parented into the existing
//! Tauri window, so there is no second `[NSApp run]` and no webview
//! GPU-compositor race (the source of the old "black canvas" bugs).

/// Smoke check for the embedded path: acquire the system Metal device the
/// same way warpui's renderer does, proving the GPU substrate links and
/// initializes inside the *host* process (not a warpui-owned app).
/// Returns the device name on success.
#[cfg(target_os = "macos")]
pub fn metal_substrate_smoke() -> Result<String, String> {
    let device = metal::Device::system_default()
        .ok_or_else(|| "no default Metal device available".to_string())?;
    Ok(device.name().to_string())
}
