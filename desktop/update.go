package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The window only shows the live portal, so a portal deploy reaches every desktop at once. This
// file updates the shell itself, which changes rarely: the newest build is published to
// mandipos-api app_releases (flavor 'desktop'); a newer one is downloaded, checked against its
// sha256 and put in place of the running exe, and the next start runs it.

type release struct {
	VersionName string `json:"versionName"`
	Sha256      string `json:"sha256"`
	SizeBytes   int64  `json:"sizeBytes"`
}

var client = &http.Client{Timeout: 10 * time.Minute}

func latest(ctx context.Context) (*release, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", apiBase()+"/v1/public/app", nil)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var body struct {
		Desktop *release `json:"desktop"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Desktop, nil
}

// newer: is a ("0.2.0") newer than b ("0.1.9")? A dev build never updates.
func newer(a, b string) bool {
	if b == "dev" || a == "" {
		return false
	}
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// pending is written when a new exe is put in place. The new one clears it once it has shown a
// page; one that fails to get that far three starts running gets swapped back out.
type pending struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Tries int    `json:"tries"`
}

func pendingPath(dir string) string { return filepath.Join(dir, "update.json") }
func skipPath(dir string) string    { return filepath.Join(dir, "update-skip.txt") }

func readPending(dir string) *pending {
	b, err := os.ReadFile(pendingPath(dir))
	if err != nil {
		return nil
	}
	var p pending
	if json.Unmarshal(b, &p) != nil {
		return nil
	}
	return &p
}

func writePending(dir string, p *pending) {
	b, _ := json.Marshal(p)
	_ = os.WriteFile(pendingPath(dir), b, 0o644)
}

// findUpdate returns the newer published build, or nil when this one is the newest (or the newer
// one is already in place, or failed here before and force is off).
func findUpdate(ctx context.Context, dir string, force bool) (*release, error) {
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	rel, err := latest(c)
	cancel()
	if err != nil || rel == nil || !newer(rel.VersionName, version) {
		return nil, err
	}
	if skip, _ := os.ReadFile(skipPath(dir)); !force && strings.TrimSpace(string(skip)) == rel.VersionName {
		return nil, nil
	}
	return rel, nil
}

// stage downloads rel and puts it in place of exe; the next start runs it.
func stage(ctx context.Context, dir, exe string, rel *release) error {
	if p := readPending(dir); p != nil && p.To == rel.VersionName {
		return nil // already in place
	}
	logf("update: %s → %s, downloading", version, rel.VersionName)
	part := exe + ".part"
	if err := download(ctx, part, rel); err != nil {
		_ = os.Remove(part)
		return err
	}
	old := exe + ".old"
	_ = os.Remove(old)
	// Windows lets a running exe be renamed, not overwritten.
	if err := os.Rename(exe, old); err != nil {
		_ = os.Remove(part)
		return err
	}
	if err := os.Rename(part, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	writePending(dir, &pending{From: version, To: rel.VersionName})
	logf("update: %s in place", rel.VersionName)
	return nil
}

// checkUpdate puts a newer published build in place of exe. It returns the version put in place,
// or "" when there is nothing newer.
func checkUpdate(ctx context.Context, dir, exe string, force bool) (string, error) {
	rel, err := findUpdate(ctx, dir, force)
	if err != nil || rel == nil {
		return "", err
	}
	if err := stage(ctx, dir, exe, rel); err != nil {
		return "", err
	}
	return rel.VersionName, nil
}

func download(ctx context.Context, path string, rel *release) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", apiBase()+"/v1/public/app/download?flavor=desktop", nil)
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, rel.Sha256) {
		return fmt.Errorf("sha256 mismatch: got %s, want %s (%d bytes)", got, rel.Sha256, n)
	}
	return nil
}

// afterStart runs once this process owns the window. It returns true when this build failed to
// come up three times and the previous exe has been put back (the caller restarts and exits).
func afterStart(dir, exe string) bool {
	p := readPending(dir)
	if p == nil {
		return false
	}
	if p.To != version {
		_ = os.Remove(pendingPath(dir))
		return false
	}
	p.Tries++
	if p.Tries <= 3 {
		writePending(dir, p)
		return false
	}
	logf("update: %s never showed a page, going back to %s", p.To, p.From)
	if _, err := os.Stat(exe + ".old"); err != nil {
		_ = os.Remove(pendingPath(dir))
		return false
	}
	_ = os.Remove(exe + ".bad")
	if os.Rename(exe, exe+".bad") != nil {
		return false
	}
	if os.Rename(exe+".old", exe) != nil {
		_ = os.Rename(exe+".bad", exe)
		return false
	}
	_ = os.WriteFile(skipPath(dir), []byte(p.To), 0o644)
	_ = os.Remove(pendingPath(dir))
	return true
}

// confirmUpdate: this build has shown a page, so it stays.
func confirmUpdate(dir, exe string) {
	if p := readPending(dir); p != nil && p.To == version {
		logf("update: now on %s (from %s)", version, p.From)
		_ = os.Remove(pendingPath(dir))
		_ = os.Remove(skipPath(dir))
	}
	_ = os.Remove(exe + ".old")
	_ = os.Remove(exe + ".bad")
}
