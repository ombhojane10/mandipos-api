//go:build !windows

package main

import (
	"fmt"
	"os"
)

// Off Windows only the updater runs (to test it): --update-now with --home and --no-install.
func run(o options) int {
	if o.updateNow == "" || o.home == "" {
		fmt.Fprintln(os.Stderr, "the window needs Windows; here only --home <dir> --update-now <file> works")
		return 2
	}
	exe, err := os.Executable()
	if err != nil {
		return 1
	}
	_ = os.MkdirAll(o.home, 0o755)
	openLog(o.home)
	return runUpdateNow(o.home, exe, o.updateNow)
}

func crashesTo(*os.File) {}
