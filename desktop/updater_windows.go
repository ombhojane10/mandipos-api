//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The portal shows the shell's update state (admin/src/DesktopUpdate.tsx) and has a button for it:
// the page sends "update:status", "update:check" or "update:apply"; the shell answers with
// {type: "update", state, version, current}. States: idle, checking, latest, downloading, ready,
// error. A ready update also goes in by itself once the window has been minimized or in the
// background for a while, so nobody has to press anything.

type updStatus struct {
	Type    string `json:"type"`
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Current string `json:"current"`
}

var (
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pGetWindowPlacement  = user32.NewProc("GetWindowPlacement")
	pSetWindowPlacement  = user32.NewProc("SetWindowPlacement")
)

const (
	wvPostWebMessageAsJson = 32
	swShowMinNoActive      = 7
	wpfRestoreToMaximized  = 2
)

func (a *app) setUpdate(state, v string) {
	a.mu.Lock()
	a.upd, a.updVersion = state, v
	a.mu.Unlock()
	a.dispatch(a.postUpdate)
}

// postUpdate tells the page the state. Window thread only.
func (a *app) postUpdate() {
	a.mu.Lock()
	st := updStatus{Type: "update", State: a.upd, Version: a.updVersion, Current: version}
	a.mu.Unlock()
	if st.State == "" {
		st.State = "idle"
	}
	b, _ := json.Marshal(st)
	p, _ := windows.UTF16PtrFromString(string(b))
	com(a.wv, wvPostWebMessageAsJson, uintptr(unsafe.Pointer(p)))
}

// checkNow looks for a newer build and puts it in place. A press of the button (manual) shows
// every step; the timed check only speaks up once an update is ready.
func (a *app) checkNow(manual bool) {
	a.mu.Lock()
	if a.checking || a.upd == "ready" {
		a.mu.Unlock()
		a.dispatch(a.postUpdate)
		return
	}
	a.checking = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.checking = false
		a.mu.Unlock()
	}()
	if manual {
		a.setUpdate("checking", "")
	}
	ctx := context.Background()
	rel, err := findUpdate(ctx, a.dir, manual)
	switch {
	case err != nil:
		logf("update check: %v", err)
		if manual {
			a.setUpdate("error", "")
		}
		return
	case rel == nil:
		if manual {
			a.setUpdate("latest", "")
		}
		return
	}
	if manual {
		a.setUpdate("downloading", rel.VersionName)
	}
	if err := stage(ctx, a.dir, a.exe, rel); err != nil {
		logf("update: %v", err)
		if manual {
			a.setUpdate("error", rel.VersionName)
		}
		return
	}
	a.setUpdate("ready", rel.VersionName)
}

// updateLoop: a check soon after start, then hourly; a ready update goes in by itself after the
// window has been minimized for 2 minutes or behind other windows for 30.
func (a *app) updateLoop() {
	time.Sleep(5 * time.Second)
	next := time.Now()
	var away time.Time
	for {
		if time.Now().After(next) {
			a.checkNow(false)
			next = time.Now().Add(time.Hour)
		}
		a.mu.Lock()
		ready := a.upd == "ready"
		a.mu.Unlock()
		if ready {
			fg, _, _ := pGetForegroundWindow.Call()
			min, _, _ := pIsIconic.Call(a.hwnd)
			limit := 30 * time.Minute
			if min != 0 {
				limit = 2 * time.Minute
			}
			if a.o.autoAfter > 0 {
				limit = a.o.autoAfter
			}
			switch {
			case fg == a.hwnd && min == 0:
				away = time.Time{}
			case away.IsZero():
				away = time.Now()
			case time.Since(away) >= limit:
				logf("update: applying %s while the window is away", a.updVersion)
				a.dispatch(func() { a.restart(true) })
				return
			}
		}
		time.Sleep(5 * time.Second)
	}
}

// restart closes this window and starts the exe again (the new build is in its place), on the
// page that was open. quiet: minimized and without taking focus, for an update applied unasked.
func (a *app) restart(quiet bool) {
	url := comString(a.wv, wvGetSource)
	if !strings.HasPrefix(url, a.origin) {
		url = a.o.url
	}
	var args []string
	skipNext := false
	for _, s := range os.Args[1:] {
		if skipNext {
			skipNext = false
			continue
		}
		name := strings.TrimLeft(strings.SplitN(s, "=", 2)[0], "-")
		switch name {
		case "url":
			skipNext = !strings.Contains(s, "=")
			continue
		case "restarted", "quiet":
			continue
		}
		args = append(args, s)
	}
	args = append(args, "--restarted", "--url="+url)
	if quiet {
		args = append(args, "--quiet")
	}
	a.restartArgs = args
	// The closing window must not call into WebView2: wails exits the process on any error.
	a.ready = false
	a.c.ShuttingDown()
	pDestroyWindow.Call(a.hwnd)
}

// showQuietly: minimized, not taking focus, maximized when restored.
func showQuietly(hwnd uintptr) {
	var wp [11]uint32 // WINDOWPLACEMENT: length, flags, showCmd, 2 POINTs, RECT
	wp[0] = uint32(unsafe.Sizeof(wp))
	pGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp[0])))
	wp[1] |= wpfRestoreToMaximized
	wp[2] = swShowMinNoActive
	pSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp[0])))
}

// onUpdateMessage handles the page's update messages; false when m isn't one.
func (a *app) onUpdateMessage(m string) bool {
	switch m {
	case "update:status":
		a.postUpdate()
	case "update:check":
		go a.checkNow(true)
	case "update:apply":
		a.mu.Lock()
		ready := a.upd == "ready"
		a.mu.Unlock()
		if ready {
			logf("update: applying %s (button)", a.updVersion)
			// After this callback returns: wails still answers the message on this webview.
			a.dispatch(func() { a.restart(false) })
		}
	default:
		return false
	}
	return true
}
