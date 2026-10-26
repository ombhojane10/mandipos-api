#!/bin/zsh
# Builds dist/MandiPlus Dashboard.exe (windows/amd64) and a mac binary for testing the updater.
#   ./build.sh 0.1.0
set -eu
cd "${0:A:h}"
V=${1:?version, e.g. 0.1.0}
T=/Users/omi/mandi/tmp/toolchain
export GOROOT=$T/go GOPATH=$T/gopath GOCACHE=$T/gocache PATH=$T/go/bin:$PATH GOFLAGS=-mod=mod
$GOPATH/bin/go-winres make --in winres/winres.json --arch amd64 --product-version $V.0 --file-version $V.0
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$V" -o "dist/MandiPlus Dashboard.exe" .
go build -trimpath -ldflags "-X main.version=$V" -o dist/mandiplus-dashboard-mac .
ls -l dist
shasum -a 256 "dist/MandiPlus Dashboard.exe"
