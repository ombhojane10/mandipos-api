//go:build windows

package main

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The few WebView2 calls the shell needs beyond wails' edge package, by vtable slot (WebView2.h
// order). wails' generated pkg/webview2 can't be imported: one of its callbacks takes a string,
// and windows.NewCallback panics on that while the package initialises.

var (
	ole32          = windows.NewLazySystemDLL("ole32.dll")
	pCoTaskMemFree = ole32.NewProc("CoTaskMemFree")
)

// ICoreWebView2 slots.
const (
	wvGetSource              = 4
	wvNavigateToString       = 6
	wvAddNavigationStarting  = 7
	wvAddNavigationCompleted = 15
	wvReload                 = 31
	wvAddNewWindowRequested  = 44
)

// ICoreWebView2Settings2 slots.
const (
	settings2GetUserAgent = 21
	settings2PutUserAgent = 22
)

// Event args slots.
const (
	navStartingGetUri    = 3
	navStartingPutCancel = 8
	newWindowGetUri      = 3
	newWindowPutHandled  = 6
	navDoneGetIsSuccess  = 3
	navDoneGetWebError   = 4
)

const webErrorCanceled = 14 // COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED

// com calls method slot of the COM object at obj.
func com(obj uintptr, slot int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// comString calls a getter that hands back a CoTaskMemAlloc'd string.
func comString(obj uintptr, slot int) string {
	var p *uint16
	if int32(com(obj, slot, uintptr(unsafe.Pointer(&p)))) < 0 || p == nil {
		return ""
	}
	s := windows.UTF16PtrToString(p)
	pCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return s
}

func comBool(obj uintptr, slot int) bool {
	var b int32
	com(obj, slot, uintptr(unsafe.Pointer(&b)))
	return b != 0
}

func comUint(obj uintptr, slot int) uint32 {
	var v uint32
	com(obj, slot, uintptr(unsafe.Pointer(&v)))
	return v
}

func boolArg(b bool) uintptr {
	if b {
		return 1
	}
	return 0
}

// handler is a WebView2 event handler: IUnknown + Invoke(sender, args).
type handler struct {
	vtbl   *handlerVtbl
	invoke func(sender, args uintptr)
}

type handlerVtbl struct{ QueryInterface, AddRef, Release, Invoke uintptr }

var sharedHandlerVtbl = &handlerVtbl{
	QueryInterface: windows.NewCallback(func(this *handler, _ uintptr, out *uintptr) uintptr {
		*out = uintptr(unsafe.Pointer(this))
		return 0
	}),
	AddRef:  windows.NewCallback(func(*handler) uintptr { return 1 }),
	Release: windows.NewCallback(func(*handler) uintptr { return 1 }),
	Invoke: windows.NewCallback(func(this *handler, sender, args uintptr) uintptr {
		this.invoke(sender, args)
		return 0
	}),
}

// on registers fn for the event whose add_ method is at slot. The handler is kept forever.
func on(wv uintptr, slot int, fn func(sender, args uintptr)) error {
	h := &handler{vtbl: sharedHandlerVtbl, invoke: fn}
	keep = append(keep, h)
	var token int64
	if hr := com(wv, slot, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&token))); int32(hr) < 0 {
		return syscall.Errno(hr)
	}
	return nil
}

func navigateToString(wv uintptr, html string) {
	p, _ := windows.UTF16PtrFromString(html)
	com(wv, wvNavigateToString, uintptr(unsafe.Pointer(p)))
}
