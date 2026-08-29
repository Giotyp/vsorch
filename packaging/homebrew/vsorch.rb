# Homebrew Cask for vsorch.
#
# This file belongs in a Homebrew *tap* repo (e.g. github.com/Giotyp/homebrew-tap
# at Casks/vsorch.rb), not in the app repo — it lives here as the source of truth.
# Once published, users install with:
#
#   brew install --cask giotyp/tap/vsorch
#
# Bump `version` and `sha256` on each release. Get the hash with:
#   shasum -a 256 vsorch-<version>-arm64.dmg
cask "vsorch" do
  version "1.0.0"
  sha256 "REPLACE_WITH_DMG_SHA256" # shasum -a 256 the released DMG

  url "https://github.com/Giotyp/vsorch/releases/download/v#{version}/vsorch-#{version}-arm64.dmg",
      verified: "github.com/Giotyp/vsorch/"
  name "vsorch"
  desc "Orchestrate multiple VS Code workbenches in a single window"
  homepage "https://github.com/Giotyp/vsorch"

  depends_on macos: ">= :sonoma"

  app "vsorch.app"

  caveats <<~EOS
    vsorch drives your installed VS Code via its `code` CLI. Make sure VS Code
    is installed and the `code` command is on your PATH — in VS Code run:
      Shell Command: Install 'code' command in PATH
  EOS
end
