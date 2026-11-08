#!/bin/sh
# Derived from @loomcli/loom 0.18.0 installer; requires an explicit version pin.
# Installs this application from its GitHub releases: it downloads the binary for this platform,
# verifies it against the release's SHA256SUMS, moves it into place, and records the installation
# in install.json. Update by rerunning this verified installer. Run it with --help for its usage.
#
# loom init renders this file. Each step is a function that the last line calls inside braces, so a
# download cut short anywhere, even within that line, runs nothing.

say() {
  printf '%s\n' "$app: $1" >&2
}

fail() {
  say "$1"
  exit 1
}

usage() {
  printf '%s\n' 'Usage: install.sh [--dir <directory>] [<version>]'
}

print_help() {
  printf '%s\n' "Install $app from the GitHub releases of $repository, verified against the release's SHA256SUMS." ''
  usage
  printf '%s\n' \
    '       install.sh --help' \
    '' \
    'Arguments:' \
    '  <version>          The release to install, such as 1.4.0, with or without a leading v.' \
    '                     Required; no implicit latest release.' \
    '' \
    'Options:' \
    '  --dir <directory>  The absolute directory to install into. By default, $HOME/.local/bin.' \
    '  -h, --help         Print this help.'
}

argument_error() {
  say "$1"
  say "$(usage)"
  exit 2
}

parse_arguments() {
  dir=
  dir_given=
  version=
  version_given=
  while [ $# -gt 0 ]; do
    case $1 in
      -h | --help)
        print_help
        exit 0
        ;;
      --dir)
        [ $# -ge 2 ] || argument_error '--dir needs a directory.'
        case $2 in
          /*) ;;
          *) argument_error "--dir needs an absolute path, and \"$2\" is not one." ;;
        esac
        dir=$2
        dir_given=1
        shift
        ;;
      -*)
        argument_error "install.sh has no option $1."
        ;;
      *)
        [ -z "$version_given" ] || argument_error "install.sh takes one version, and $1 is a second one."
        version=${1#v}
        version_given=1
        case $version in
          '' | *[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-]*)
            argument_error "\"$1\" is not a version, which holds only letters, digits, ., -, and +."
            ;;
        esac
        ;;
    esac
    shift
  done
  while :; do
    case $dir in
      / | '') break ;;
      */) dir=${dir%/} ;;
      *) break ;;
    esac
  done
}

unsupported_platform() {
  fail "This release supports Linux x64 with glibc; detected $os $arch."
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  [ "$os" = Linux ] || unsupported_platform
  case $arch in
    x86_64 | amd64) ;;
    *) unsupported_platform ;;
  esac
  command -v ldd >/dev/null 2>&1 || unsupported_platform
  case $(ldd --version 2>&1 || :) in
    *musl*) unsupported_platform ;;
    *GLIBC* | *glibc* | *'GNU libc'*) ;;
    *) unsupported_platform ;;
  esac
  platform=linux-x64
  asset=$app-$platform
}

is_gnu_wget() {
  case $(wget --version 2>/dev/null || :) in
    *'GNU Wget'*) return 0 ;;
  esac
  return 1
}

find_downloader() {
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1 && is_gnu_wget; then
    downloader=wget
  else
    fail 'Neither curl nor GNU Wget is installed. Install curl, then run the installer again.'
  fi
}

find_digest_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    digest_tool=shasum
  else
    fail 'Neither sha256sum nor shasum is installed. Install sha256sum from GNU coreutils, then run the installer again.'
  fi
}

check_install_directory() {
  if [ -z "$dir_given" ]; then
    case ${HOME:-} in
      /*) ;;
      *) fail 'HOME is not an absolute path. Set it to your home directory, then run the installer again.' ;;
    esac
    dir=$HOME/.local/bin
  fi
  target=${dir%/}/$app
  if [ -d "$target" ]; then
    fail "$target is a directory. Remove it, or choose another install directory with --dir."
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    fail "$dir is not a directory. Remove it, or choose another install directory with --dir."
  fi
}

prepare_record() {
# $app is the application's name; $target is the installed binary's absolute path.
case $target in
  *[\"\\]* | *[[:cntrl:]]*) echo "$app: The install path holds a quote, a backslash, or a control character. Choose another install directory." >&2; exit 1 ;;
  /*) ;;
  *) echo "$app: The install path is not absolute. Choose an absolute install directory." >&2; exit 1 ;;
esac
case $(uname -s) in
  Darwin) home_needed=1; state="$HOME/Library/Application Support" ;;
  *) case ${XDG_STATE_HOME:-} in /*) home_needed=; state=$XDG_STATE_HOME ;; *) home_needed=1; state="$HOME/.local/state" ;; esac ;;
esac
if [ -n "$home_needed" ]; then
  case ${HOME:-} in /*) ;; *) echo "$app: HOME is not an absolute path. Set it to your home directory, then run the installer again." >&2; exit 1 ;; esac
fi
record="$state/$app/installation"
mkdir -p "$record" 2>/dev/null || { echo "$app: The installation record's directory $record cannot be created. Make it a directory you can write to, then run the installer again." >&2; exit 1; }
}

fetch() {
  if [ "$downloader" = curl ]; then
    curl --fail --location --silent --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" >"$2" 2>/dev/null || download_failed "$1"
  else
    wget --quiet --secure-protocol=TLSv1_2 -O - "$1" >"$2" 2>/dev/null || download_failed "$1"
  fi
}

download_failed() {
  fail "Cannot download $1. Check your network connection and that the release exists, then run the installer again."
}

sha256_of() {
  if [ "$digest_tool" = sha256sum ]; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

read_listed_digest() {
  expected=
  while IFS= read -r line || [ -n "$line" ]; do
    hex=${line%% *}
    case $hex in
      *[!0123456789abcdef]*) continue ;;
    esac
    [ ${#hex} -eq 64 ] || continue
    if [ "$line" = "$hex  $asset" ] || [ "$line" = "$hex *$asset" ]; then
      if [ -n "$expected" ] && [ "$expected" != "$hex" ]; then
        fail "SHA256SUMS of $release_name of $repository lists $asset twice with different digests. Report it to the maintainers of $repository, or name another release."
      fi
      expected=$hex
    fi
  done <"$sums"
  if [ -z "$expected" ]; then
    fail "SHA256SUMS of $release_name of $repository lists no $asset. Name a release that publishes it, or install $app another way."
  fi
}

install_binary() {
  if [ -n "$version" ]; then
    base=https://github.com/$repository/releases/download/v$version
    release_name="release v$version"
  else
    base=https://github.com/$repository/releases/latest/download
    release_name='the latest release'
  fi
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || fail "Cannot create the install directory $dir. Choose a directory you can write to with --dir."
  fi
  sums=$(mktemp "$dir/.$app.sums.XXXXXX" 2>/dev/null) || fail "Cannot write to the install directory $dir. Choose a directory you can write to with --dir."
  download=$(mktemp "$dir/.$app.XXXXXX" 2>/dev/null) || fail "Cannot write to the install directory $dir. Choose a directory you can write to with --dir."
  say "Downloading $asset from $release_name of $repository."
  fetch "$base/SHA256SUMS" "$sums"
  read_listed_digest
  fetch "$base/$asset" "$download"
  actual=$(sha256_of "$download")
  if [ "${actual%% *}" != "$expected" ]; then
    fail "The download of $asset does not match its digest in SHA256SUMS. Run the installer again, and report it to the maintainers of $repository if it fails again."
  fi
  binary_asset=$asset
  asset=$app-NOTICES.txt
  read_listed_digest
  notice_download=$(mktemp "$dir/.$app.notices.XXXXXX") || fail "Cannot stage notices in $dir. Choose a writable directory with --dir."
  fetch "$base/$asset" "$notice_download"
  actual=$(sha256_of "$notice_download")
  [ "${actual%% *}" = "$expected" ] || fail "Notice checksum mismatch. Rerun the installer and report repeated failures to the maintainers of $repository."
  [ -s "$notice_download" ] || fail "Notices are empty. Report the release to the maintainers of $repository or select another release."
  chmod 755 "$download" || fail "Cannot prepare the executable. Check permissions in $dir and rerun the installer."
  chmod 644 "$notice_download" || fail "Cannot prepare notices. Check permissions in $dir and rerun the installer."
  notice_backup=$(mktemp "$dir/.$app.previous-notices.XXXXXX") || fail "Cannot stage recovery notices. Check permissions in $dir and rerun the installer."
  had_notices=0
  if [ -e "$target.NOTICES.txt" ]; then
    cp -p "$target.NOTICES.txt" "$notice_backup" || fail "Cannot preserve existing notices. Check permissions in $dir and rerun the installer."
    had_notices=1
  fi
  mv -f "$notice_download" "$target.NOTICES.txt" || fail "Cannot install notices. Check permissions in $dir and rerun the installer."
  notice_download=
  asset=$binary_asset
  if ! mv -f "$download" "$target"; then
    if [ "$had_notices" = 1 ]; then
      recovery=$notice_backup
      if ! mv -f "$notice_backup" "$target.NOTICES.txt"; then
        notice_backup=
        fail "Cannot restore previous notices. Recover them from $recovery before rerunning the installer."
      fi
      notice_backup=
    else
      rm -f "$target.NOTICES.txt" || fail "Cannot remove new notices after executable installation failed. Check permissions in $dir before rerunning the installer."
    fi
    fail "Cannot install the executable; previous notices were restored. Check permissions in $dir and rerun the installer."
  fi
  download=
}

write_record() {
# Once the verified binary is at $target:
if command -v sha256sum >/dev/null 2>&1; then digest=$(sha256sum "$target"); else digest=$(shasum -a 256 "$target"); fi
staging=$(mktemp "$record/.install.json.XXXXXX")
printf '{"format":1,"method":"script","path":"%s","digest":"sha256:%s"}\n' "$target" "${digest%% *}" >"$staging"
mv -f "$staging" "$record/install.json"
}

advise_path() {
  case :$PATH: in
    *:"$dir":*) ;;
    *)
      say "$dir is not on PATH. Add it to your shell's PATH to run $app:"
      printf '  export PATH="%s:$PATH"\n' "$dir" >&2
      ;;
  esac
  found=$(command -v "$app" 2>/dev/null || :)
  case $found in
    /*)
      if [ "$found" != "$target" ]; then
        say "$found runs first on PATH. Remove it, or move $dir earlier on PATH."
      fi
      ;;
  esac
}

cleanup() {
  if [ -n "${notice_backup:-}" ]; then rm -f "$notice_backup"; fi
  if [ -n "${notice_download:-}" ]; then rm -f "$notice_download"; fi
  if [ -n "${download:-}" ]; then rm -f "$download"; fi
  if [ -n "${sums:-}" ]; then rm -f "$sums"; fi
  if [ -n "${staging:-}" ]; then rm -f "$staging"; fi
}

main() {
  set -e
  app='modgud'
  repository='dbtlr/modgud'
  download=
  sums=
  staging=
  trap cleanup EXIT
  trap 'cleanup; exit 1' HUP INT TERM
  parse_arguments "$@"
  [ -n "$version" ] || argument_error 'Name an explicit release version.'
  detect_platform
  find_downloader
  find_digest_tool
  check_install_directory
  prepare_record
  install_binary
  write_record
  say "Installed $target."
  advise_path
}

{ main "$@"; }

# Installer derivation: @loomcli/loom 0.18.0, MIT License.
# Copyright (c) 2026 Drew Butler
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
