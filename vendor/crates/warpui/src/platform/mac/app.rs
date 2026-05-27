use std::borrow::Cow;
use std::ffi::CStr;
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;

use cocoa::appkit::NSApp;
use cocoa::base::{id, nil};
use cocoa::foundation::{NSArray, NSAutoreleasePool, NSData, NSString, NSUInteger, NSURL};
use futures_util::future::LocalBoxFuture;
use objc::runtime::{Object, Sel, BOOL, NO, YES};
use objc::{class, msg_send, sel, sel_impl};
use warpui_core::assets::AssetProvider;
use warpui_core::integration::TestDriver;
use warpui_core::keymap::{Keystroke, Trigger};
use warpui_core::modals::{AlertDialog, ModalId};
use warpui_core::platform::app::{AppCallbackDispatcher, ApproveTerminateResult};
use warpui_core::platform::menu::{Menu, MenuBar};
use warpui_core::platform::{self, FilePickerCallback, SaveFilePickerCallback};
use warpui_core::{AppContext, Event};

use super::keycode::{Keycode, CMD_KEY, CONTROL_KEY, OPTION_KEY, SHIFT_KEY};
use super::make_nsstring;
use super::menus::{make_dock_menu, make_main_menu};
use super::window::{get_window_state, IntegrationTestWindowManager, Window, WindowManager};
use crate::platform::app::{AppBackend, AppBuilder};
use crate::platform::AsInnerMut;

pub trait NSAlert: Sized {
    unsafe fn alloc(_: Self) -> id {
        msg_send![class!(NSAlert), alloc]
    }

    unsafe fn init(self) -> id;
    unsafe fn autorelease(self) -> id;
    unsafe fn set_message_text(self, message_text: id);
    unsafe fn set_informative_text(self, informative_text: id);
    unsafe fn add_button_with_title(self, title: id);
}

impl NSAlert for id {
    unsafe fn init(self) -> id {
        msg_send![self, init]
    }

    unsafe fn autorelease(self) -> id {
        msg_send![self, autorelease]
    }

    unsafe fn set_message_text(self, message_text: id) {
        msg_send![self, setMessageText: message_text]
    }

    unsafe fn set_informative_text(self, informative_text: id) {
        msg_send![self, setInformativeText: informative_text]
    }

    unsafe fn add_button_with_title(self, title: id) {
        msg_send![self, addButtonWithTitle: title]
    }
}

pub fn create_native_platform_modal(dialog: AlertDialog) -> id {
    unsafe {
        let alert = NSAlert::autorelease(NSAlert::init(NSAlert::alloc(nil)));
        alert.set_informative_text(make_nsstring(&dialog.info_text));
        alert.set_message_text(make_nsstring(&dialog.message_text));
        for title in dialog.buttons {
            alert.add_button_with_title(make_nsstring(&title));
        }
        alert
    }
}

const RUST_WRAPPER_IVAR_NAME: &str = "rustWrapper";

// When warpui is embedded in a host application (e.g. a Tauri window), the
// process's `NSApp` is the host's `NSApplication` subclass (e.g. tao's
// `TaoApp`), which has no `rustWrapper` ivar. In that mode the `App`
// pointer is published here instead, and `get_app` reads it first. Null
// (the default) means "not embedded — use the NSApp ivar".
thread_local! {
    static EMBEDDED_APP: std::cell::Cell<*mut App> =
        const { std::cell::Cell::new(std::ptr::null_mut()) };
}

// The embedded child NSWindow (warpui's surface) once reparented into a host
// window. Used by `reposition_embedded_surface` to track the host's terminal
// region. `nil` until `attach_embedded` reparents.
thread_local! {
    static EMBEDDED_CHILD: std::cell::Cell<id> = const { std::cell::Cell::new(0 as id) };
}

// The most-recently-created warpui NSWindow, captured at window-creation time
// (see `note_created_window`, called from `window.rs`). In embedded mode the
// host (Tauri) owns NSApp activation, so warpui's window never becomes *key* —
// `Window::key_window()` returns `None`/the host window during `attach_embedded`
// and the reparent would be skipped, leaving the surface a floating top-level
// window. Reading the captured window instead makes embedding reliable.
thread_local! {
    static EMBEDDED_NEW_WINDOW: std::cell::Cell<id> = const { std::cell::Cell::new(0 as id) };
}

/// Record a freshly-created warpui NSWindow so `attach_embedded` can reparent
/// it without depending on AppKit key-window state. Called from `window.rs`.
pub(super) fn note_created_window(native_window: id) {
    EMBEDDED_NEW_WINDOW.with(|c| c.set(native_window));
}

/// Reposition the embedded warpui surface to cover a sub-region of the host
/// window's content area. The rect is in CSS/point coordinates relative to the
/// content's top-left (origin top-left, Y-down — i.e. `getBoundingClientRect`).
/// MUST be called on the main thread. No-op until `attach_embedded` has run.
pub fn reposition_embedded_surface(
    parent_nswindow: *mut c_void,
    css_x: f64,
    css_y: f64,
    css_w: f64,
    css_h: f64,
) {
    if parent_nswindow.is_null() {
        return;
    }
    let child = EMBEDDED_CHILD.with(|c| c.get());
    if child.is_null() {
        return;
    }
    unsafe {
        let parent = parent_nswindow as id;
        let parent_frame: cocoa::foundation::NSRect = msg_send![parent, frame];
        let content: cocoa::foundation::NSRect =
            msg_send![parent, contentRectForFrameRect: parent_frame];
        // `content.origin` is the bottom-left of the content area in screen
        // coords (Y up). Convert the web rect (top-left origin, Y down) into a
        // bottom-left screen rect for the child window frame.
        let content_top_y = content.origin.y + content.size.height;
        let child_x = content.origin.x + css_x;
        let child_y = content_top_y - css_y - css_h;
        let frame = cocoa::foundation::NSRect::new(
            cocoa::foundation::NSPoint::new(child_x, child_y),
            cocoa::foundation::NSSize::new(css_w, css_h),
        );
        {
            use std::sync::atomic::{AtomicU32, Ordering};
            static N: AtomicU32 = AtomicU32::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            if n < 6 {
                eprintln!(
                    "[warpui] reposition#{n}: css=({css_x},{css_y}) {css_w}x{css_h} -> frame=({child_x},{child_y})"
                );
            }
        }
        let _: () = msg_send![child, setFrame: frame display: YES];
    }
}

/// Force a repaint of the embedded warpui surface. Host apps call this from
/// the main thread after pushing new render state (e.g. a terminal frame
/// produced on a PTY reader thread) into a view's shared state, since that
/// mutation happens outside warpui's normal event flow and so doesn't itself
/// schedule a redraw. No-op until `attach_embedded` has published the App.
pub fn poke_embedded_redraw() {
    let app = EMBEDDED_APP.with(|c| c.get());
    if app.is_null() {
        return;
    }
    // SAFETY: `app` was published by `attach_embedded` on this (main) thread
    // and outlives the process; `poke_embedded_redraw` is documented main-thread
    // only, matching the single-threaded AppKit ownership of `App`.
    unsafe {
        (*app).callbacks.poke_redraw();
    }
}

/// Request an off-screen capture of the embedded surface's next frame
/// (`window_id` is the warpui window created in the host's `add_window`). The
/// callback receives RGBA pixels — hosts use it to screenshot the render for
/// verification without Screen Recording permission. Main-thread only.
pub fn capture_embedded(
    window_id: warpui_core::WindowId,
    callback: Box<dyn FnOnce(platform::CapturedFrame) + Send + 'static>,
) {
    let app = EMBEDDED_APP.with(|c| c.get());
    if app.is_null() {
        return;
    }
    // SAFETY: see `poke_embedded_redraw` — main-thread only, `app` outlives proc.
    unsafe {
        (*app).callbacks.capture_window(window_id, callback);
    }
}

/// Mouse-event kinds an embedded host can inject via [`dispatch_embedded_mouse`].
#[derive(Clone, Copy)]
pub enum EmbeddedMouseKind {
    Down,
    Dragged,
    Up,
}

/// Inject a left-mouse event into the embedded surface, forwarded by a host that
/// captures input in its own layer (the embedded child window has
/// `ignoresMouseEvents: YES`, so AppKit never delivers mouse events to it). `(x,
/// y)` are top-left-origin logical points relative to the surface — the same
/// coordinate space as the rect passed to [`reposition_embedded_surface`], which
/// is what the mac event path produces after flipping `locationInWindow`. The
/// event runs through warpui's normal hit-testing / selection dispatch. Main-
/// thread only; no-op until `attach_embedded` has published the App.
#[allow(clippy::too_many_arguments)]
pub fn dispatch_embedded_mouse(
    window_id: warpui_core::WindowId,
    kind: EmbeddedMouseKind,
    x: f64,
    y: f64,
    click_count: u32,
    shift: bool,
    cmd: bool,
    alt: bool,
    ctrl: bool,
) {
    let app = EMBEDDED_APP.with(|c| c.get());
    if app.is_null() {
        return;
    }
    use pathfinder_geometry::vector::vec2f;
    use warpui_core::event::ModifiersState;
    let position = vec2f(x as f32, y as f32);
    let modifiers = ModifiersState {
        alt,
        cmd,
        shift,
        ctrl,
        func: false,
    };
    let event = match kind {
        EmbeddedMouseKind::Down => Event::LeftMouseDown {
            position,
            modifiers,
            click_count: click_count.max(1),
            is_first_mouse: false,
        },
        EmbeddedMouseKind::Dragged => Event::LeftMouseDragged { position, modifiers },
        EmbeddedMouseKind::Up => Event::LeftMouseUp { position, modifiers },
    };
    // SAFETY: see `poke_embedded_redraw` — main-thread only, `app` outlives proc.
    unsafe {
        (*app).callbacks.inject_mouse_event(window_id, event);
    }
}

extern "C" {
    // Implemented in ObjC to get the warp NSApplication subclass.
    pub(super) fn get_warp_app() -> id;
}

/// An extension trait defining additional configurability for
/// applications when running on macOS.
pub trait AppExt {
    /// Sets whether or not the application should be activated
    /// when it is launched.
    fn set_activate_on_launch(&mut self, value: bool);

    /// Sets the application icon which should be used when running
    /// without an application bundle.
    fn set_dev_icon(&mut self, value: Cow<'static, [u8]>);

    /// Sets the main menu bar constructor function.
    fn set_menu_bar_builder(&mut self, value: impl FnOnce(&mut AppContext) -> MenuBar + 'static);

    /// Sets the macOS dock menu constructor function.
    fn set_dock_menu_builder(&mut self, value: impl FnOnce(&mut AppContext) -> Menu + 'static);
}

type MenuBarBuilderFn = Box<dyn FnOnce(&mut AppContext) -> MenuBar>;
type DockMenuBuilderFn = Box<dyn FnOnce(&mut AppContext) -> Menu>;

/// The actual application, from the perspective of the platform and the
/// main event loop.  This is the true owner of all application state.
pub struct App {
    callbacks: AppCallbackDispatcher,
    activate_on_launch: bool,
    dev_icon: Option<Cow<'static, [u8]>>,
    menu_bar_builder: Option<MenuBarBuilderFn>,
    dock_menu_builder: Option<DockMenuBuilderFn>,
    init_fn: Option<platform::app::AppInitCallbackFn>,
}

impl App {
    pub(in crate::platform) fn new(
        callbacks: platform::app::AppCallbacks,
        assets: Box<dyn AssetProvider>,
        test_driver: Option<&TestDriver>,
    ) -> Self {
        let platform_delegate: Box<dyn platform::Delegate> = if test_driver.is_some() {
            Box::new(
                super::delegate::IntegrationTestDelegate::new()
                    .expect("should not fail to create platform delegate"),
            )
        } else {
            Box::new(
                super::delegate::AppDelegate::new()
                    .expect("should not fail to create platform delegate"),
            )
        };

        let window_manager: Box<dyn platform::WindowManager> = if test_driver.is_some() {
            Box::new(IntegrationTestWindowManager::new())
        } else {
            Box::new(WindowManager::new())
        };

        let ui_app = crate::App::new(
            platform_delegate,
            window_manager,
            Box::new(super::fonts::FontDB::new()),
            assets,
        )
        .expect("should not fail to construct application");

        Self {
            callbacks: AppCallbackDispatcher::new(callbacks, ui_app),
            activate_on_launch: true,
            dev_icon: None,
            menu_bar_builder: None,
            dock_menu_builder: None,
            init_fn: None,
        }
    }

    pub(in crate::platform) fn run(
        mut self,
        init_fn: impl FnOnce(&mut AppContext, LocalBoxFuture<'static, crate::App>) + 'static,
    ) {
        self.init_fn = Some(Box::new(init_fn));

        unsafe {
            let pool = NSAutoreleasePool::new(nil);

            // Get (and create, if necessary) the underlying NSApplication.
            let app: id = get_warp_app();

            let running_app: id = msg_send![class!(NSRunningApplication), currentApplication];
            let bundle_id: id = msg_send![running_app, bundleIdentifier];
            let dev_icon = if bundle_id.is_null() {
                self.dev_icon.as_ref().map(|dev_icon| {
                    let data: id = msg_send![class!(NSData), alloc];
                    let data: id = data.initWithBytes_length_(
                        dev_icon.as_ptr() as *const c_void,
                        dev_icon.len() as u64,
                    );
                    let image: id = msg_send![class!(NSImage), alloc];
                    image.initWithData_(data)
                })
            } else {
                None
            };

            let app_delegate: id = msg_send![app, delegate];

            let self_ptr = Box::into_raw(Box::new(self));
            (*app).set_ivar(RUST_WRAPPER_IVAR_NAME, self_ptr as *mut c_void);
            (*app_delegate).set_ivar(RUST_WRAPPER_IVAR_NAME, self_ptr as *mut c_void);

            if let Some(dev_icon) = dev_icon {
                let _: () = msg_send![app, setApplicationIconImage: dev_icon];
            }

            let _: () = msg_send![app, run];
            let _: () = msg_send![pool, drain];

            // App is done running when we get here, so we can reinstantiate the Box and drop it.
            drop(Box::from_raw(self_ptr));
        }
    }

    /// Like [`run`], but for an *embedded* surface: the host application
    /// (e.g. a Tauri window) already owns `NSApplication` and the main
    /// run loop, so we must NOT create a Warp `NSApplication` subclass or
    /// call `[NSApp run]` (doing so would nest a second run loop). Instead
    /// we initialize the UI app directly — running `init_fn`, which
    /// creates and renders the window(s) — and keep the `App` alive for
    /// the lifetime of the host process. Rendering is then driven by the
    /// host view's `CALayerDelegate` (`setNeedsDisplay`) and the GCD
    /// foreground executor, both serviced by the host's existing run loop.
    pub(in crate::platform) fn attach_embedded(
        mut self,
        parent_nswindow: *mut c_void,
        init_fn: impl FnOnce(&mut AppContext, LocalBoxFuture<'static, crate::App>) + 'static,
    ) {
        self.init_fn = Some(Box::new(init_fn));
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            // Publish the App pointer to the warpui-side global BEFORE init,
            // so deeper code (executor, window callbacks → `get_app`) finds it
            // without the host NSApp's missing `rustWrapper` ivar. Leaked for
            // the process lifetime — there's no `[NSApp run]` return to drop on.
            let app_ptr = Box::into_raw(Box::new(self));
            EMBEDDED_APP.with(|c| c.set(app_ptr));
            let app = &mut *app_ptr;
            if let Some(init_fn) = app.init_fn.take() {
                app.callbacks.initialize_app(init_fn);
            }
            // Embedded apps never receive AppKit's `applicationDidBecomeActive`
            // (the host owns the app delegate), so warpui's window manager
            // would never transition to the `Active` stage that presents
            // windows. Drive that activation manually so the freshly-created
            // window is actually shown.
            app.callbacks.app_became_active();

            // Reparent our freshly-created (now key) window into the host
            // window so it composites in-app rather than as a separate
            // top-level window: size it to the host's content area, then
            // attach it as a child so it tracks the host's moves/resizes.
            if !parent_nswindow.is_null() {
                let parent = parent_nswindow as id;
                // Use the window we just created (reliable in embedded mode),
                // falling back to the key window for the standalone path.
                let child_window = {
                    let created = EMBEDDED_NEW_WINDOW.with(|c| c.get());
                    if !created.is_null() {
                        Some(created)
                    } else {
                        Window::key_window()
                    }
                };
                if child_window.is_none() {
                    eprintln!(
                        "[warpui] reparent: NO child window (created=nil, key_window=None) — surface will float!"
                    );
                }
                if let Some(child) = child_window {
                    EMBEDDED_CHILD.with(|c| c.set(child));
                    // Strip the child's title bar / traffic lights: it's an
                    // in-app overlay, not a standalone window. Borderless (mask
                    // 0) also makes the Metal content fill the whole frame
                    // instead of being inset below a title bar.
                    let _: () = msg_send![child, setStyleMask: 0u64];
                    // Belt-and-suspenders: if the window manager keeps a titled
                    // style, hide the three traffic-light buttons explicitly so
                    // the surface reads as in-app chrome, not a window.
                    // NSWindowButton: Close=0, Miniaturize=1, Zoom=2.
                    for tag in 0u64..=2 {
                        let btn: id = msg_send![child, standardWindowButton: tag];
                        if btn != nil {
                            let _: () = msg_send![btn, setHidden: YES];
                        }
                    }
                    // No drop shadow / opaque black: a shadow draws a grey halo
                    // around the surface that reads as a floating window rather
                    // than in-app chrome.
                    let _: () = msg_send![child, setHasShadow: NO];
                    // Force an opaque black window background. The default
                    // NSWindow background is light grey; once the window is
                    // sized to the terminal-pane rect, that grey peeks around
                    // the Metal layer's edges as a stray "grey border". Black +
                    // opaque means only the Metal content (the terminal) shows.
                    let black: id = msg_send![class!(NSColor), blackColor];
                    let _: () = msg_send![child, setBackgroundColor: black];
                    let _: () = msg_send![child, setOpaque: YES];
                    let parent_frame: cocoa::foundation::NSRect = msg_send![parent, frame];
                    let content_rect: cocoa::foundation::NSRect =
                        msg_send![parent, contentRectForFrameRect: parent_frame];
                    eprintln!(
                        "[warpui] reparent: child={:p} parent={:p} content_rect=({},{}) {}x{}",
                        child,
                        parent,
                        content_rect.origin.x,
                        content_rect.origin.y,
                        content_rect.size.width,
                        content_rect.size.height
                    );
                    let _: () = msg_send![child, setFrame: content_rect display: YES];
                    let _: () = msg_send![
                        parent,
                        addChildWindow: child
                        // BELOW the host webview. The webview is made
                        // transparent and the terminal pane is punched out as
                        // a CSS hole, so this Metal surface composites *behind*
                        // the web UI. React overlays (update toast, command
                        // palette, dropdowns) and the terminal's own input box
                        // now paint on top of the surface instead of being
                        // covered by it.
                        ordered: cocoa::appkit::NSWindowOrderingMode::NSWindowBelow
                    ];
                    // The embedded surface is display-only until native input
                    // lands (M3): keyboard + mouse are still handled by the
                    // host's WebView (which now sits ABOVE this surface). Make
                    // the child click-through so mouse events reach the webview,
                    // and hand key status back to the host so keystrokes flow to
                    // the web input. Without this the freshly-created child stays
                    // key and silently swallows every keypress — the terminal
                    // looks frozen.
                    let _: () = msg_send![child, setIgnoresMouseEvents: YES];
                    let _: () = msg_send![parent, makeKeyWindow];
                }
            }
            let _: () = msg_send![pool, drain];
        }
    }
}

impl AppExt for AppBuilder {
    fn set_activate_on_launch(&mut self, value: bool) {
        match self.as_inner_mut() {
            AppBackend::CurrentPlatform(app) => app.activate_on_launch = value,
            AppBackend::Headless(_) => (),
        }
    }

    fn set_dev_icon(&mut self, value: Cow<'static, [u8]>) {
        match self.as_inner_mut() {
            AppBackend::CurrentPlatform(app) => app.dev_icon = Some(value),
            AppBackend::Headless(_) => (),
        }
    }

    fn set_menu_bar_builder(&mut self, value: impl FnOnce(&mut AppContext) -> MenuBar + 'static) {
        match self.as_inner_mut() {
            AppBackend::CurrentPlatform(app) => app.menu_bar_builder = Some(Box::new(value)),
            AppBackend::Headless(_) => (),
        }
    }

    fn set_dock_menu_builder(&mut self, value: impl FnOnce(&mut AppContext) -> Menu + 'static) {
        match self.as_inner_mut() {
            AppBackend::CurrentPlatform(app) => app.dock_menu_builder = Some(Box::new(value)),
            AppBackend::Headless(_) => (),
        }
    }
}

unsafe fn get_app(object: &mut Object) -> &mut App {
    // Embedded host (e.g. Tauri): the App pointer lives in a warpui global
    // because the host's NSApp has no `rustWrapper` ivar. Prefer it.
    let embedded = EMBEDDED_APP.with(|c| c.get());
    if !embedded.is_null() {
        return &mut *embedded;
    }
    let wrapper_ptr: *mut c_void = *object.get_ivar(RUST_WRAPPER_IVAR_NAME);
    &mut *(wrapper_ptr as *mut App)
}

pub(super) fn callback_dispatcher() -> &'static mut AppCallbackDispatcher {
    unsafe {
        let app = get_warp_app();
        let app = get_app(&mut *app);
        &mut app.callbacks
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_send_global_keybinding(
    this: &mut Object,
    modifiers: NSUInteger,
    key_code: NSUInteger,
) {
    let keystroke = {
        let modifiers = modifiers as u16;
        let shift_key_pressed = (modifiers & SHIFT_KEY) > 0;
        Keycode(key_code as u16)
            .try_to_key_name(shift_key_pressed)
            .map(|key| Keystroke {
                ctrl: (modifiers & CONTROL_KEY) > 0,
                alt: (modifiers & OPTION_KEY) > 0,
                shift: shift_key_pressed,
                cmd: (modifiers & CMD_KEY) > 0,
                meta: false,
                key,
            })
    };

    if let Some(keystroke) = keystroke {
        let app = unsafe { get_app(this) };
        app.callbacks.global_shortcut_triggered(keystroke);
    }
}

#[no_mangle]
pub unsafe extern "C-unwind" fn warp_app_will_finish_launching(this: &mut Object) {
    log::info!("application will finish launching");

    let app = get_app(this);

    if app.activate_on_launch {
        let _: () = msg_send![NSApp(), activateIgnoringOtherApps: YES];
    }

    if let Some(init_fn) = app.init_fn.take() {
        app.callbacks.initialize_app(init_fn);
    }

    let app_delegate: id = msg_send![NSApp(), delegate];

    if app.callbacks.has_internet_reachability_changed_callback() {
        let _: () = msg_send![app_delegate, setReachabilityListener];
    }

    if let Some(menu_bar_builder) = app.menu_bar_builder.take() {
        let menu_bar = app.callbacks.with_mutable_app_context(menu_bar_builder);
        let nsmenu = make_main_menu(menu_bar);
        let () = msg_send![NSApp(), setMainMenu: nsmenu];
    }

    if let Some(dock_menu_builder) = app.dock_menu_builder.take() {
        let dock_menu = app.callbacks.with_mutable_app_context(dock_menu_builder);
        let nsmenu = make_dock_menu(dock_menu);
        let _: () = msg_send![app_delegate, setDockMenu: nsmenu];
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_did_become_active(this: &mut Object, _: Sel, _: id) {
    let app = unsafe { get_app(this) };
    app.callbacks.app_became_active();
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_internet_reachability_changed(
    this: &mut Object,
    can_reach: u8,
) {
    let is_reachable = can_reach != 0;

    let app = unsafe { get_app(this) };
    app.callbacks.internet_reachability_changed(is_reachable);
}

/// Returns whether or not we can proceed with termination.
#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_should_terminate_app(this: &mut Object) -> BOOL {
    let app = unsafe { get_app(this) };

    match app.callbacks.should_terminate_app() {
        ApproveTerminateResult::Terminate => YES,
        ApproveTerminateResult::Cancel => NO,
    }
}

/// Returns a NSAlert object if we want to show a dialog for users to confirm or
/// nil for closing the window immediately.
#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_should_close_window(
    this: &mut Object,
    window_id: &mut Object,
) -> BOOL {
    let app = unsafe { get_app(this) };
    let window = unsafe { get_window_state(window_id) };

    match app.callbacks.should_close_window(window.id()) {
        ApproveTerminateResult::Terminate => YES,
        ApproveTerminateResult::Cancel => NO,
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_are_key_bindings_disabled_for_window(
    this: &mut Object,
    window_id: &mut Object,
) -> BOOL {
    let app = unsafe { get_app(this) };
    let window = unsafe { get_window_state(window_id) };

    let disabled = app
        .callbacks
        .with_mutable_app_context(|ctx| !ctx.key_bindings_enabled(window.id()));

    if disabled {
        YES
    } else {
        NO
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_has_binding_for_keystroke(
    this: &mut Object,
    event: id,
) -> BOOL {
    let app = unsafe { get_app(this) };
    let warp_event = unsafe { super::event::from_native(event, None, false) };

    let Some(Event::KeyDown { keystroke, .. }) = warp_event else {
        return NO;
    };
    let has_binding = app.callbacks.with_mutable_app_context(|ctx| {
        ctx.get_key_bindings().any(|binding| {
            if let Trigger::Keystrokes(keystrokes) = binding.trigger {
                keystrokes.len() == 1 && keystrokes[0] == keystroke
            } else {
                false
            }
        })
    });

    if has_binding {
        YES
    } else {
        NO
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_has_custom_action_for_keystroke(
    this: &mut Object,
    event: id,
) -> BOOL {
    let app = unsafe { get_app(this) };
    let warp_event = unsafe { super::event::from_native(event, None, false) };

    let Some(Event::KeyDown { keystroke, .. }) = warp_event else {
        return NO;
    };
    let has_binding = app.callbacks.with_mutable_app_context(|ctx| {
        ctx.custom_action_bindings()
            .any(|binding| match binding.trigger {
                Trigger::Keystrokes(keystrokes) => {
                    keystrokes.len() == 1 && keystrokes[0] == keystroke
                }
                Trigger::Custom(tag) => ctx
                    .default_keystroke_trigger_for_custom_action(*tag)
                    .is_some_and(|k| k == keystroke),
                _ => false,
            })
    });

    if has_binding {
        YES
    } else {
        NO
    }
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_disable_warning_modal(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.warning_modal_disabled();
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_process_modal_response(
    this: &mut Object,
    modal_id: ModalId,
    response: usize,
    disable_modal: bool,
) {
    let app = unsafe { get_app(this) };
    app.callbacks
        .process_platform_modal_response(modal_id, response, disable_modal);
}

#[no_mangle]
pub(crate) extern "C-unwind" fn warp_app_notification_clicked(
    this: &mut Object,
    date: f64,
    data: id,
) {
    let app = unsafe { get_app(this) };
    if let Ok(notification_response) =
        unsafe { super::notification::response_from_native(date as i32, data) }
    {
        app.callbacks.notification_clicked(notification_response);
    }
}

#[no_mangle]
extern "C-unwind" fn warp_app_did_resign_active(this: &mut Object, _: Sel, _: id) {
    let app = unsafe { get_app(this) };
    app.callbacks.app_resigned_active();
}

#[no_mangle]
extern "C-unwind" fn warp_app_will_terminate(this: &mut Object, _: Sel, _: id) {
    let app = unsafe { get_app(this) };
    app.callbacks.app_will_terminate();
}

#[no_mangle]
extern "C-unwind" fn warp_app_new_window(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.open_new_window();
}

#[no_mangle]
extern "C-unwind" fn warp_app_active_window_changed(this: &mut Object) {
    let app = unsafe { get_app(this) };
    Window::close_ime_on_active_window();
    app.callbacks
        .active_window_changed(Window::active_window_id());
}

#[no_mangle]
extern "C-unwind" fn warp_app_window_did_resize(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.window_resized();
}

#[no_mangle]
extern "C-unwind" fn warp_app_window_did_move(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.window_moved();
}

#[no_mangle]
extern "C-unwind" fn warp_app_window_will_close(this: &mut Object, window: &mut Object) {
    let app = unsafe { get_app(this) };
    let window_state = unsafe { get_window_state(window) };
    app.callbacks.window_will_close(window_state.id());
}

#[no_mangle]
extern "C-unwind" fn warp_app_screen_did_change(this: &mut Object) {
    log::info!("received NSApplicationDidChangeScreenParametersNotification");
    let app = unsafe { get_app(this) };
    app.callbacks.screen_changed();
}

#[no_mangle]
extern "C-unwind" fn cpu_awakened(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.cpu_awakened();
}

#[no_mangle]
extern "C-unwind" fn cpu_will_sleep(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.cpu_will_sleep();
}

#[no_mangle]
extern "C-unwind" fn warp_app_open_files(this: &mut Object, paths: id) {
    let paths = unsafe {
        (0..paths.count())
            .filter_map(|i| {
                let path = paths.objectAtIndex(i);
                match CStr::from_ptr(path.UTF8String() as *mut c_char).to_str() {
                    Ok(string) => Some(PathBuf::from(string)),
                    Err(err) => {
                        log::error!("error converting path to string: {err}");
                        None
                    }
                }
            })
            .collect::<Vec<_>>()
    };
    let app = unsafe { get_app(this) };
    app.callbacks.open_files(paths);
}

#[no_mangle]
extern "C-unwind" fn warp_app_open_urls(this: &mut Object, urls: id) {
    let urls = unsafe {
        (0..urls.count())
            .filter_map(|i| {
                let url = urls.objectAtIndex(i).absoluteString();
                match CStr::from_ptr(url.UTF8String() as *mut c_char).to_str() {
                    Ok(string) => Some(string.to_string()),
                    Err(err) => {
                        log::error!("error converting url to string: {err}");
                        None
                    }
                }
            })
            .collect::<Vec<_>>()
    };

    let app = unsafe { get_app(this) };
    app.callbacks.open_urls(urls);
}

#[no_mangle]
extern "C-unwind" fn warp_app_os_appearance_changed(this: &mut Object) {
    let app = unsafe { get_app(this) };
    app.callbacks.os_appearance_changed();
}

// Calls the callback with None if no file was selected
#[no_mangle]
pub(crate) extern "C-unwind" fn warp_open_panel_file_selected(urls: id, callback: *mut c_void) {
    // Start by converting the callback from a raw pointer back into a Box, to
    // avoid the memory leak that would occur if we left it in raw pointer form.
    let callback = unsafe { Box::from_raw(callback as *mut FilePickerCallback) };

    let paths = unsafe {
        (0..urls.count())
            .map(|i| {
                let file_url = urls.objectAtIndex(i);
                let file_path: id = msg_send![file_url, path];
                let slice = std::slice::from_raw_parts(
                    file_path.UTF8String() as *const std::ffi::c_uchar,
                    file_path.len(),
                );
                std::str::from_utf8_unchecked(slice).to_string()
            })
            .collect::<Vec<_>>()
    };

    if paths.is_empty() {
        log::info!("No file was selected. Dialog was cancelled.")
    }

    let app = unsafe { get_app(&mut *get_warp_app()) };
    app.callbacks.with_mutable_app_context(move |ctx| {
        callback(Ok(paths), ctx);
    });
}

// Calls the save callback with the selected path or None if cancelled
#[no_mangle]
pub(crate) extern "C-unwind" fn warp_save_panel_file_selected(url: id, callback: *mut c_void) {
    let callback = unsafe { Box::from_raw(callback as *mut SaveFilePickerCallback) };

    let path = if url.is_null() {
        None
    } else {
        unsafe {
            let file_path: id = msg_send![url, path];
            let slice = std::slice::from_raw_parts(
                file_path.UTF8String() as *const std::ffi::c_uchar,
                file_path.len(),
            );
            Some(std::str::from_utf8_unchecked(slice).to_string())
        }
    };

    if path.is_none() {
        log::info!("Save dialog was cancelled.");
    }

    let app = unsafe { get_app(&mut *get_warp_app()) };
    app.callbacks.with_mutable_app_context(move |ctx| {
        callback(path, ctx);
    });
}
