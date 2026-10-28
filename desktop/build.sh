#!/bin/zsh
# Builds dist/<app>.exe (windows/amd64) and a mac binary for testing the updater.
#   ./build.sh 0.1.0        MandiPlus Dashboard      — the Tally-look portal, releases flavor 'desktop'
#   ./build.sh 0.1.0 new    MandiPlus Dashboard New  — the new-look beta portal, flavor 'desktop-new'
set -eu
cd "${0:A:h}"
V=${1:?version, e.g. 0.1.0}
APP="MandiPlus Dashboard"; X=""
if [[ ${2:-} == new ]]; then
  APP="MandiPlus Dashboard New"
  X="-X 'main.appName=$APP' -X main.portal=https://mandipos-admin-beta.onrender.com/ -X main.flavor=desktop-new"
fi
T=/Users/omi/mandi/tmp/toolchain
export GOROOT=$T/go GOPATH=$T/gopath GOCACHE=$T/gocache PATH=$T/go/bin:$PATH GOFLAGS=-mod=mod
# The exe's own name in Windows (file properties, the installer entry) follows the app.
sed "s/MandiPlus Dashboard/$APP/g" winres/winres.json > winres/winres.build.json
$GOPATH/bin/go-winres make --in winres/winres.build.json --arch amd64 --product-version $V.0 --file-version $V.0
rm winres/winres.build.json
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$V $X" -o "dist/$APP.exe" .
go build -trimpath -ldflags "-X main.version=$V $X" -o "dist/$(echo $APP | tr ' A-Z' '-a-z')-mac" .
ls -l dist
shasum -a 256 "dist/$APP.exe"
