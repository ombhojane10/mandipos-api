// MandiPlus Dashboard: the MandiPOS owners' portal in its own Windows window (WebView2).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

const (
	appName = "MandiPlus Dashboard"
	portal  = "https://mandipos-admin.onrender.com/"
	apiBase = "https://mandipos-api.onrender.com"
)

// version is set at build time (-X main.version=x.y.z).
var version = "dev"

type options struct {
	home      string // data folder; default %LOCALAPPDATA%\MandiPlus Dashboard
	noInstall bool   // run from where it is, without copying itself or making shortcuts
	debug     bool   // DevTools on
	smoke     string // load the portal, write what the page can do to this file, exit
	updateNow string // check for a newer shell now, write the outcome to this file, exit
	typing    string // log the keys the page gets for 40 s, write them to this file, exit
	uninstall bool
	url       string
}

// test: a run driven by the smoke workflow, not a shop owner.
func (o options) test() bool { return o.smoke != "" || o.typing != "" }

func parseFlags() options {
	var o options
	flag.StringVar(&o.home, "home", "", "data folder")
	flag.BoolVar(&o.noInstall, "no-install", false, "run in place")
	flag.BoolVar(&o.debug, "debug", false, "DevTools")
	flag.StringVar(&o.smoke, "smoke", "", "smoke test, results to this file")
	flag.StringVar(&o.updateNow, "update-now", "", "update check, outcome to this file")
	flag.StringVar(&o.typing, "typing", "", "keyboard test, results to this file")
	flag.BoolVar(&o.uninstall, "uninstall", false, "remove shortcuts and data")
	flag.StringVar(&o.url, "url", portal, "page to open")
	showVersion := flag.Bool("version", false, "print the version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	return o
}

var logger = log.New(os.Stderr, "", log.LstdFlags)

func logf(format string, args ...interface{}) { logger.Printf(format, args...) }

// openLog appends to dashboard.log in the data folder, starting it afresh past 1 MB.
func openLog(dir string) {
	p := filepath.Join(dir, "dashboard.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		_ = os.Rename(p, p+".1")
	}
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		logger.SetOutput(f)
		crashesTo(f)
	}
}

// runUpdateNow is --update-now: one check, the outcome in a file (a GUI exe has no console).
func runUpdateNow(dir, exe, out string) int {
	v, err := checkUpdate(context.Background(), dir, exe, true)
	msg, code := "", 0
	switch {
	case err != nil:
		msg, code = "error: "+err.Error(), 1
	case v == "":
		msg = "up to date: " + version
	default:
		msg = "updated: " + version + " -> " + v
	}
	_ = os.WriteFile(out, []byte(msg+"\n"), 0o644)
	return code
}

func main() {
	o := parseFlags()
	defer func() {
		if r := recover(); r != nil {
			logf("panic: %v\n%s", r, debug.Stack())
			os.Exit(2)
		}
	}()
	os.Exit(run(o))
}

func trimSlash(s string) string { return strings.TrimRight(s, "/") }
