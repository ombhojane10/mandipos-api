//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// The download is one exe. Its first run copies it to %LOCALAPPDATA%\MandiPlus Dashboard (no admin
// rights needed), adds Desktop and Start menu shortcuts and an entry in Apps & features, and
// starts the copy. Updates replace that copy.

var uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\` + className

func installedExe(dir string) string { return filepath.Join(dir, appName+".exe") }

// install returns the installed copy to start instead of this one; false means run this one.
func install(dir, self string) (string, bool) {
	target := installedExe(dir)
	if strings.EqualFold(filepath.Clean(self), filepath.Clean(target)) {
		return "", false
	}
	// Never put an older download over a copy that has updated itself.
	if b, err := os.ReadFile(filepath.Join(dir, "version.txt")); err == nil {
		if have := strings.TrimSpace(string(b)); !newer(version, have) && fileExists(target) {
			logf("install: keeping %s (this download is %s)", have, version)
			makeShortcuts(target)
			return target, true
		}
	}
	part := target + ".part"
	if err := copyFile(self, part); err != nil {
		logf("install: %v", err)
		return "", false
	}
	if fileExists(target) {
		_ = os.Remove(target + ".old")
		if err := os.Rename(target, target+".old"); err != nil {
			logf("install: %v", err)
			_ = os.Remove(part)
			return "", false
		}
	}
	if err := os.Rename(part, target); err != nil {
		logf("install: %v", err)
		return "", false
	}
	logf("install: %s → %s", self, target)
	makeShortcuts(target)
	return target, true
}

// registerInstall runs at every start of the installed copy: version for the next download to
// compare against, and the Apps & features entry.
func registerInstall(dir, exe string) {
	if !strings.EqualFold(filepath.Clean(exe), filepath.Clean(installedExe(dir))) {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "version.txt"), []byte(version), 0o644)
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("DisplayName", appName)
	_ = k.SetStringValue("DisplayVersion", version)
	_ = k.SetStringValue("DisplayIcon", exe+",0")
	_ = k.SetStringValue("Publisher", "MandiPlus")
	_ = k.SetStringValue("InstallLocation", dir)
	_ = k.SetStringValue("UninstallString", `"`+exe+`" --uninstall`)
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	if st, err := os.Stat(exe); err == nil {
		_ = k.SetDWordValue("EstimatedSize", uint32(st.Size()/1024))
	}
}

func uninstall(dir string) int {
	name, _ := windows.UTF16PtrFromString("Local\\" + className)
	if _, _, err := pCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name))); err == windows.ERROR_ALREADY_EXISTS {
		messageBox(appName+" abhi khula hai. Pehle use band karein.", mbIconInfo)
		return 1
	}
	for _, f := range shortcutFolders() {
		_ = os.Remove(filepath.Join(f, appName+".lnk"))
	}
	_ = registry.DeleteKey(registry.CURRENT_USER, uninstallKey)
	messageBox(appName+" hata diya gaya.", mbIconInfo)
	// The folder holds this exe, so cmd removes it once this process is gone (and tries again
	// while WebView2's helpers let go of their files).
	// The line is handed to cmd as is: Go's own quoting (\") means nothing to cmd.
	q := `"` + dir + `"`
	cmd := exec.Command("cmd.exe")
	cmd.Dir = os.TempDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000,
		CmdLine: "cmd.exe /c ping -n 3 127.0.0.1 >nul & rmdir /s /q " + q + " & if exist " + q + " (ping -n 6 127.0.0.1 >nul & rmdir /s /q " + q + ")"}
	_ = cmd.Start()
	return 0
}

func start(exe string, args ...string) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		logf("start %s: %v", exe, err)
	}
}

func shortcutFolders() []string {
	var out []string
	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_Desktop, windows.FOLDERID_Programs} {
		if p, err := windows.KnownFolderPath(id, 0); err == nil {
			out = append(out, p)
		}
	}
	return out
}

// makeShortcuts puts "MandiPlus Dashboard" on the Desktop and in the Start menu.
func makeShortcuts(exe string) {
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		if e, ok := err.(*ole.OleError); !ok || e.Code() != 1 { // S_FALSE: already initialised
			logf("shortcut: %v", err)
		}
	}
	unk, err := oleutil.CreateObject("WScript.Shell")
	if err != nil {
		logf("shortcut: %v", err)
		return
	}
	defer unk.Release()
	sh, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return
	}
	defer sh.Release()
	for _, f := range shortcutFolders() {
		v, err := oleutil.CallMethod(sh, "CreateShortcut", filepath.Join(f, appName+".lnk"))
		if err != nil {
			logf("shortcut: %v", err)
			continue
		}
		l := v.ToIDispatch()
		_, _ = oleutil.PutProperty(l, "TargetPath", exe)
		_, _ = oleutil.PutProperty(l, "WorkingDirectory", filepath.Dir(exe))
		_, _ = oleutil.PutProperty(l, "IconLocation", exe+",0")
		_, _ = oleutil.PutProperty(l, "Description", appName)
		if _, err := oleutil.CallMethod(l, "Save"); err != nil {
			logf("shortcut: %v", err)
		}
		l.Release()
	}
}

// noWebView: Windows without the WebView2 runtime (Windows 7/8 that never got it). Edge or Chrome
// in app mode shows the same portal; with neither, Microsoft's WebView2 installer is offered.
func noWebView(dir, url string) int {
	pf, pf86, local := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	for _, b := range []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
	} {
		if fileExists(b) {
			logf("no WebView2: opening %s in app mode", b)
			start(b, "--app="+url, "--user-data-dir="+filepath.Join(dir, "browser"), "--no-first-run")
			return 0
		}
	}
	if messageBox("Is computer par Microsoft WebView2 nahi hai. OK dabane par uska installer download hoga; install karke "+appName+" phir se kholein.", mbOKCancel|mbIconInfo) == idOK {
		_ = windows.ShellExecute(0, windows.StringToUTF16Ptr("open"),
			windows.StringToUTF16Ptr("https://go.microsoft.com/fwlink/p/?LinkId=2124703"), nil, nil, swShowNormal)
	}
	return 0
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
