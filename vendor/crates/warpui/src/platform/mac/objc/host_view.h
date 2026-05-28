#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

@interface NSPasteboard (Warp)
- (NSArray *)getFilePaths;
@end

/// WarpHostView is the Content view of a Warp window.
// It is backed by a Metal CALayer.
@interface WarpHostView : NSView <CALayerDelegate, NSTextInputClient>
- (WarpHostView *)initWithFrame:(NSRect)frame
                    metalDevice:(id)metalDevice
             enableTitlebarDrag:(BOOL)enableTitlebarDrag
                       testMode:(BOOL)testMode;
- (void)setAsyncCallback:(BOOL)shouldAsync;
- (void)setPresentsWithTransaction:(BOOL)presentsWithTransaction;
- (BOOL)keyDownImpl:(NSEvent *)event;
/// When YES, `hitTest:` returns nil so AppKit treats this view as
/// click-through. Embedded hosts set this on the view while it's
/// reparented into the host's contentView (native fullscreen), so the
/// webview sitting above it receives all mouse events and the React
/// handler drives selection through `dispatch_embedded_mouse` — same
/// path as windowed mode (where the surface lives in a child window
/// with `ignoresMouseEvents:YES`).
- (void)setMouseTransparent:(BOOL)transparent;
@end
