//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

// --smoke <file>: open the portal, check from inside the page what the shell must provide
// (storage, camera, mic, downloads, outside links), write it all to <file> and close.
// The links are recorded, not opened.

const smokeName = "mandiplus-smoke.csv"

const smokeScript = `(async () => {
  const r = { href: location.href, title: document.title, ua: navigator.userAgent,
    inputs: document.querySelectorAll('input').length, text: document.body.innerText.slice(0, 200),
    barcodeDetector: 'BarcodeDetector' in window, dpr: devicePixelRatio, width: innerWidth, serviceWorker: !!navigator.serviceWorker?.controller }
  try { localStorage.setItem('mp.smoke', '1'); r.localStorage = localStorage.getItem('mp.smoke') === '1' } catch (e) { r.localStorage = String(e) }
  const gum = async (c) => {
    try {
      const s = await Promise.race([navigator.mediaDevices.getUserMedia(c),
        new Promise((_, no) => setTimeout(() => no(new Error('no answer (prompt shown?)')), 6000))])
      s.getTracks().forEach((t) => t.stop()); return 'granted'
    } catch (e) { return e.name + ': ' + e.message }
  }
  r.mic = await gum({ audio: true })
  r.camera = await gum({ video: true })
  r.permissions = {}
  for (const n of ['camera', 'microphone']) {
    try { r.permissions[n] = (await navigator.permissions.query({ name: n })).state } catch (e) { r.permissions[n] = String(e) }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['a,b\n1,2\n'], { type: 'text/csv' })); a.download = '` + smokeName + `'
  document.body.appendChild(a); a.click(); a.remove()
  const ext = document.createElement('a')
  ext.href = 'https://example.com/'; ext.target = '_blank'; ext.rel = 'noreferrer'
  document.body.appendChild(ext); ext.click(); ext.remove()
  window.open('https://wa.me/919022353647', '_blank')
  setTimeout(() => { location.href = 'tel:+919022353647' }, 300)
  setTimeout(() => chrome.webview.postMessage('smoke:' + JSON.stringify(r)), 1500)
})()`

// --typing <file>: every keydown the page sees for 40 s, and what ended up in its fields. The
// workflow types into the window with real (SendKeys) input meanwhile.
const typingListen = `window.__keys = []; addEventListener('keydown', (e) => __keys.push(e.key), true)`

const typingReport = `chrome.webview.postMessage('typing:' + JSON.stringify({
  keys: window.__keys, hasFocus: document.hasFocus(),
  active: document.activeElement && (document.activeElement.tagName + ' ' + (document.activeElement.placeholder || '')),
  values: [...document.querySelectorAll('input')].map((i) => i.value) }))`

func (a *app) message(m string, _ *edge.ICoreWebView2, _ *edge.ICoreWebView2WebMessageReceivedEventArgs) {
	if a.o.typing != "" && strings.HasPrefix(m, "typing:") {
		var page map[string]interface{}
		_ = json.Unmarshal([]byte(strings.TrimPrefix(m, "typing:")), &page)
		writeSmoke(a.o.typing, map[string]interface{}{"shell": version, "page": page})
		os.Exit(0)
	}
	if a.o.smoke == "" || !strings.HasPrefix(m, "smoke:") {
		return
	}
	var page map[string]interface{}
	_ = json.Unmarshal([]byte(strings.TrimPrefix(m, "smoke:")), &page)
	go func() {
		dl := ""
		if p, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0); err == nil {
			for i := 0; i < 20 && dl == ""; i++ {
				time.Sleep(500 * time.Millisecond)
				if st, err := os.Stat(filepath.Join(p, smokeName)); err == nil && st.Size() > 0 {
					dl = filepath.Join(p, smokeName)
				}
			}
		}
		rt, _ := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
		a.dispatch(func() {
			writeSmoke(a.o.smoke, map[string]interface{}{
				"shell": version, "webview2": rt, "page": page, "download": dl, "externals": a.externals,
			})
			// The print preview should be on screen for the screenshot taken after this file appears.
			a.c.Eval("print()")
			go func() {
				time.Sleep(10 * time.Second)
				os.Exit(0)
			}()
		})
	}()
}

func writeSmoke(path string, v map[string]interface{}) {
	b, _ := json.MarshalIndent(v, "", "  ")
	_ = os.WriteFile(path+".tmp", b, 0o644)
	_ = os.Rename(path+".tmp", path)
}
