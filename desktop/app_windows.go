//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/go-webview2/pkg/webview2"
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

func init() { runtime.LockOSThread() }

var (
	user32               = windows.NewLazySystemDLL("user32.dll")
	pRegisterClassExW    = user32.NewProc("RegisterClassExW")
	pCreateWindowExW     = user32.NewProc("CreateWindowExW")
	pDefWindowProcW      = user32.NewProc("DefWindowProcW")
	pGetMessageW         = user32.NewProc("GetMessageW")
	pTranslateMessage    = user32.NewProc("TranslateMessage")
	pDispatchMessageW    = user32.NewProc("DispatchMessageW")
	pPostQuitMessage     = user32.NewProc("PostQuitMessage")
	pPostMessageW        = user32.NewProc("PostMessageW")
	pShowWindow          = user32.NewProc("ShowWindow")
	pUpdateWindow        = user32.NewProc("UpdateWindow")
	pDestroyWindow       = user32.NewProc("DestroyWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pFindWindowW         = user32.NewProc("FindWindowW")
	pIsIconic            = user32.NewProc("IsIconic")
	pLoadIconW           = user32.NewProc("LoadIconW")
	pLoadCursorW         = user32.NewProc("LoadCursorW")
	pMessageBoxW         = user32.NewProc("MessageBoxW")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetDpiForWindow     = user32.NewProc("GetDpiForWindow") // Windows 10 1607+
	pGetDC               = user32.NewProc("GetDC")
	pReleaseDC           = user32.NewProc("ReleaseDC")
	gdi32                = windows.NewLazySystemDLL("gdi32.dll")
	pGetDeviceCaps       = gdi32.NewProc("GetDeviceCaps")
	kernel32             = windows.NewLazySystemDLL("kernel32.dll")
	pGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	pCreateMutexW        = kernel32.NewProc("CreateMutexW")
)

const (
	className = "MandiPlusDashboard"

	wmDestroy       = 0x0002
	wmMove          = 0x0003
	wmSize          = 0x0005
	wmActivate      = 0x0006
	wmClose         = 0x0010
	wmGetMinMaxInfo = 0x0024
	wmDpiChanged    = 0x02E0
	wmApp           = 0x8000

	wsOverlappedWindow = 0x00CF0000
	cwUseDefault       = 0x80000000
	swShowMaximized    = 3
	swRestore          = 9
	swShowNormal       = 1

	mbOK          = 0x0
	mbOKCancel    = 0x1
	mbIconError   = 0x10
	mbIconInfo    = 0x40
	idOK          = 1
	logPixelsX    = 88
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
)

type wndClassEx struct {
	Size, Style        uint32
	WndProc            uintptr
	ClsExtra, WndExtra int32
	Instance, Icon     uintptr
	Cursor, Background uintptr
	MenuName           *uint16
	ClassName          *uint16
	IconSm             uintptr
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	X, Y    int32
	private uint32
}

type app struct {
	o      options
	dir    string
	exe    string
	hwnd   uintptr
	c      *edge.Chromium
	wv     *webview2.ICoreWebView2
	ready  bool
	origin string // scheme://host of the portal

	shown   bool // a page has loaded once
	offline bool // the offline page is up

	mu    sync.Mutex
	queue []func()

	// --smoke
	smokeStarted bool
	externals    []string
}

var the *app

func run(o options) int {
	dir := o.home
	if dir == "" {
		dir = filepath.Join(os.Getenv("LOCALAPPDATA"), appName)
	}
	_ = os.MkdirAll(dir, 0o755)
	openLog(dir)
	exe, err := os.Executable()
	if err != nil {
		return 1
	}
	if o.uninstall {
		return uninstall(dir)
	}
	if o.updateNow != "" {
		return runUpdateNow(dir, exe, o.updateNow)
	}
	if o.smoke != "" {
		o.noInstall = true
	}
	if !o.noInstall {
		if target, ok := install(dir, exe); ok {
			start(target)
			return 0
		}
	}
	if o.smoke == "" && !singleInstance() {
		return 0
	}
	logf("start %s (%s)", version, exe)
	if o.smoke == "" && afterStart(dir, exe) {
		start(exe)
		return 0
	}
	if !o.noInstall {
		registerInstall(dir, exe)
	}

	rt, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
	if err != nil || rt == "" {
		logf("no WebView2 runtime (%v)", err)
		if o.smoke != "" {
			writeSmoke(o.smoke, map[string]interface{}{"error": "no WebView2 runtime"})
			return 3
		}
		return noWebView(dir, o.url)
	}
	logf("WebView2 %s", rt)

	u, _ := url.Parse(o.url)
	a := &app{o: o, dir: dir, exe: exe, origin: u.Scheme + "://" + u.Host}
	the = a
	if o.smoke != "" {
		go func() {
			time.Sleep(120 * time.Second)
			logf("smoke: timeout")
			writeSmoke(o.smoke, map[string]interface{}{"error": "timeout", "externals": a.externals})
			os.Exit(3)
		}()
	}
	if err := a.open(rt); err != nil {
		logf("window: %v", err)
		return 1
	}
	if o.smoke == "" && version != "dev" {
		go updateLoop(dir, exe)
	}
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	if a.c != nil {
		a.c.ShuttingDown()
	}
	return 0
}

// crashesTo sends the Go runtime's own crash output (fd 2) into the log: a GUI exe has no console.
func crashesTo(f *os.File) {
	_ = windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
}

// singleInstance: a second start brings the open window forward instead.
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString("Local\\" + className)
	_, _, err := pCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if err != windows.ERROR_ALREADY_EXISTS {
		return true
	}
	cls, _ := windows.UTF16PtrFromString(className)
	if h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0); h != 0 {
		if r, _, _ := pIsIconic.Call(h); r != 0 {
			pShowWindow.Call(h, swRestore)
		}
		pSetForegroundWindow.Call(h)
	}
	return false
}

func (a *app) open(runtimeVersion string) error {
	_ = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	inst, _, _ := pGetModuleHandleW.Call(0)
	icon, _, _ := pLoadIconW.Call(inst, 1)
	cursor, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	cls, _ := windows.UTF16PtrFromString(className)
	wc := wndClassEx{
		WndProc:   windows.NewCallback(wndProc),
		Instance:  inst,
		Icon:      icon,
		IconSm:    icon,
		Cursor:    cursor,
		ClassName: cls,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return fmt.Errorf("RegisterClassEx: %v", err)
	}
	title, _ := windows.UTF16PtrFromString(appName)
	a.hwnd, _, _ = pCreateWindowExW.Call(0, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)),
		wsOverlappedWindow, cwUseDefault, cwUseDefault, 1280, 800, 0, 0, inst, 0)
	if a.hwnd == 0 {
		return fmt.Errorf("CreateWindowEx failed")
	}
	pShowWindow.Call(a.hwnd, swShowMaximized)
	pUpdateWindow.Call(a.hwnd)
	logf("window up, starting WebView2")

	c := edge.NewChromium()
	a.c = c
	c.DataPath = filepath.Join(a.dir, "WebView2")
	// The portal's Scan (camera) and Bolo (mic) ask once per page load; the shell answers yes.
	c.SetPermission(edge.CoreWebView2PermissionKindCamera, edge.CoreWebView2PermissionStateAllow)
	c.SetPermission(edge.CoreWebView2PermissionKindMicrophone, edge.CoreWebView2PermissionStateAllow)
	c.SetPermission(edge.CoreWebView2PermissionKindClipboardRead, edge.CoreWebView2PermissionStateAllow)
	c.SetErrorCallback(func(err error) {
		logf("webview error: %v", err)
		if a.o.smoke != "" {
			writeSmoke(a.o.smoke, map[string]interface{}{"error": err.Error()})
		} else if !a.ready {
			messageBox(appName+" khul nahi paya.\n\n"+err.Error(), mbIconError)
		}
	})
	c.MessageCallback = a.message
	c.ProcessFailedCallback = func(_ *edge.ICoreWebView2, _ *edge.ICoreWebView2ProcessFailedEventArgs) {
		logf("webview process failed, reloading")
		a.dispatch(func() { _ = a.wv.Reload() })
	}
	if !c.Embed(a.hwnd) {
		return fmt.Errorf("WebView2 embed failed")
	}
	logf("WebView2 ready")
	ew, err := c.GetController().GetCoreWebView2()
	if err != nil {
		return err
	}
	a.wv = (*webview2.ICoreWebView2)(unsafe.Pointer(ew))

	if s, err := c.GetSettings(); err == nil {
		_ = s.PutAreDevToolsEnabled(a.o.debug)
		_ = s.PutIsStatusBarEnabled(false)
		_ = s.PutIsZoomControlEnabled(true)
		if s2 := s.GetICoreWebView2Settings2(); s2 != nil {
			// The portal hides its "app download" links when it sees this.
			if ua, err := s2.GetUserAgent(); err == nil && !strings.Contains(ua, "MandiPlusDesktop") {
				_ = s2.PutUserAgent(ua + " MandiPlusDesktop/" + version)
			}
		}
	}
	_ = c.PutIsSwipeNavigationEnabled(false)
	c.SetBackgroundColour(0xf5, 0xf7, 0xea, 255)

	h := &events{a: a}
	keep = append(keep, h)
	navStarting := webview2.NewICoreWebView2NavigationStartingEventHandler(h)
	newWindow := webview2.NewICoreWebView2NewWindowRequestedEventHandler(h)
	navCompleted := webview2.NewICoreWebView2NavigationCompletedEventHandler(h)
	keep = append(keep, navStarting, newWindow, navCompleted)
	if _, err := a.wv.AddNavigationStarting(navStarting); err != nil {
		return err
	}
	if _, err := a.wv.AddNewWindowRequested(newWindow); err != nil {
		return err
	}
	if _, err := a.wv.AddNavigationCompleted(navCompleted); err != nil {
		return err
	}
	// Newer runtimes ask before handing tel: etc. to Windows; the shell does it without the prompt.
	if wv18 := a.wv.GetICoreWebView2_18(); wv18 != nil {
		launching := webview2.NewICoreWebView2LaunchingExternalUriSchemeEventHandler(h)
		keep = append(keep, launching)
		_, _ = wv18.AddLaunchingExternalUriScheme(launching)
	}

	a.ready = true
	a.fitDpi()
	c.Resize()
	c.Focus()
	c.Navigate(a.o.url)
	logf("opening %s", a.o.url)
	return nil
}

// keep holds what WebView2 calls back into, so the GC never frees it.
var keep []interface{}

func wndProc(hwnd, m, wp, lp uintptr) uintptr {
	a := the
	switch m {
	case wmSize:
		if a != nil && a.ready {
			a.c.Resize()
		}
	case wmMove:
		if a != nil && a.ready {
			_ = a.c.NotifyParentWindowPositionChanged()
		}
	case wmActivate:
		if a != nil && a.ready && wp&0xffff != 0 {
			a.c.Focus()
		}
	case wmGetMinMaxInfo:
		// MINMAXINFO.ptMinTrackSize
		mm := (*[10]int32)(unsafe.Pointer(lp))
		mm[6], mm[7] = 720, 480
		return 0
	case wmDpiChanged:
		r := (*[4]int32)(unsafe.Pointer(lp))
		pSetWindowPos.Call(hwnd, 0, uintptr(r[0]), uintptr(r[1]), uintptr(r[2]-r[0]), uintptr(r[3]-r[1]), swpNoZOrder|swpNoActivate)
		if a != nil && a.ready {
			a.fitDpi()
		}
		return 0
	case wmApp:
		if a != nil {
			a.mu.Lock()
			q := a.queue
			a.queue = nil
			a.mu.Unlock()
			for _, f := range q {
				f()
			}
		}
		return 0
	case wmClose:
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, m, wp, lp)
	return r
}

// dispatch runs f on the window's thread, where WebView2 must be called.
func (a *app) dispatch(f func()) {
	a.mu.Lock()
	a.queue = append(a.queue, f)
	a.mu.Unlock()
	pPostMessageW.Call(a.hwnd, wmApp, 0, 0)
}

// fitDpi: the controller works in raw pixels, so the page is scaled to the monitor by hand.
func (a *app) fitDpi() {
	dpi := uintptr(0)
	if pGetDpiForWindow.Find() == nil {
		dpi, _, _ = pGetDpiForWindow.Call(a.hwnd)
	}
	if dpi == 0 {
		dc, _, _ := pGetDC.Call(a.hwnd)
		dpi, _, _ = pGetDeviceCaps.Call(dc, logPixelsX)
		pReleaseDC.Call(a.hwnd, dc)
	}
	if dpi == 0 {
		return
	}
	if c3 := a.c.GetController().GetICoreWebView2Controller3(); c3 != nil {
		_ = c3.PutRasterizationScale(float64(dpi) / 96)
	}
}

// inside: pages that stay in the window. Anything else opens in the default browser or app.
func (a *app) inside(uri string) bool {
	if uri == a.origin || strings.HasPrefix(uri, a.origin+"/") {
		return true
	}
	for _, p := range []string{"about:", "data:", "blob:"} {
		if strings.HasPrefix(uri, p) {
			return true
		}
	}
	return false
}

// external hands a link to Windows: https to the default browser, tel: to the phone app, etc.
func (a *app) external(uri string) {
	u, err := url.Parse(uri)
	if err != nil {
		return
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "tel", "mailto", "whatsapp", "sms":
	default:
		logf("blocked link %q", uri)
		return
	}
	if a.o.smoke != "" {
		a.externals = append(a.externals, uri)
		return
	}
	go func() {
		if err := windows.ShellExecute(0, windows.StringToUTF16Ptr("open"), windows.StringToUTF16Ptr(uri), nil, nil, swShowNormal); err != nil {
			logf("open %q: %v", uri, err)
		}
	}()
}

type events struct{ a *app }

func (h *events) QueryInterface(_, _ uintptr) uintptr { return 0 }
func (h *events) AddRef() uintptr                     { return 1 }
func (h *events) Release() uintptr                    { return 1 }

func (h *events) NavigationStarting(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2NavigationStartingEventArgs) uintptr {
	uri, err := args.GetUri()
	if err != nil || h.a.inside(uri) {
		return 0
	}
	_ = args.PutCancel(true)
	h.a.external(uri)
	return 0
}

func (h *events) NewWindowRequested(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2NewWindowRequestedEventArgs) uintptr {
	uri, err := args.GetUri()
	if err != nil || h.a.inside(uri) {
		return 0 // a PDF opened from a blob: gets WebView2's own window, with print and save
	}
	_ = args.PutHandled(true)
	h.a.external(uri)
	return 0
}

func (h *events) LaunchingExternalUriScheme(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2LaunchingExternalUriSchemeEventArgs) uintptr {
	uri, err := args.GetUri()
	if err != nil {
		return 0
	}
	_ = args.PutCancel(true)
	h.a.external(uri)
	return 0
}

func (h *events) NavigationCompleted(_ *webview2.ICoreWebView2, args *webview2.ICoreWebView2NavigationCompletedEventArgs) uintptr {
	a := h.a
	ok, _ := args.GetIsSuccess()
	status, _ := args.GetWebErrorStatus()
	src, _ := a.wv.GetSource()
	logf("loaded ok=%v status=%d %s", ok, status, src)
	if !ok {
		if status == webview2.COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
			return 0
		}
		if a.o.smoke != "" {
			writeSmoke(a.o.smoke, map[string]interface{}{"error": fmt.Sprintf("load failed, status %d", status)})
			os.Exit(3)
		}
		a.offline = true
		_ = a.wv.NavigateToString(offlinePage(a.o.url, status))
		return 0
	}
	if !a.shown {
		a.shown = true
		confirmUpdate(a.dir, a.exe)
	}
	if strings.HasPrefix(src, a.origin) {
		a.offline = false
		if a.o.smoke != "" && !a.smokeStarted {
			a.smokeStarted = true
			go func() {
				time.Sleep(4 * time.Second)
				a.dispatch(func() { a.c.Eval(smokeScript) })
			}()
		}
	}
	return 0
}

func offlinePage(target string, status webview2.COREWEBVIEW2_WEB_ERROR_STATUS) string {
	title := "Internet nahi hai"
	switch status {
	case 6, 7, 9, 10, 11, 12, 13: // unreachable, timeout, aborted, reset, disconnected, cannot connect, DNS
	default:
		title = "Dashboard abhi khul nahi raha"
	}
	t, _ := json.Marshal(target)
	return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7ea;font:15px Verdana,sans-serif;color:#1d2b2d}
div{text-align:center}h1{font-size:18px;margin:0 0 18px}
button{font:inherit;font-weight:bold;padding:8px 22px;border:1px solid #2a6b73;background:#2a6b73;color:#fff;cursor:pointer}
</style></head><body><div><h1>` + title + `</h1><button id="b">Phir se kholein</button></div><script>
var u=` + string(t) + `;function go(){location.href=u}
document.getElementById('b').onclick=go;
setInterval(function(){fetch(u,{mode:'no-cors',cache:'no-store'}).then(go,function(){})},15000);
addEventListener('online',go);
</script></body></html>`
}

func messageBox(text string, flags uintptr) int {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(appName)
	r, _, _ := pMessageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(r)
}
