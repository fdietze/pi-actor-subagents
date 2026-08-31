{
  description = "pi-actor-subagents — development toolchain for the pi extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # KISS: Nix owns tools; npm owns only the versioned TypeScript declarations.
      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.typescript-go
          pkgs.oxlint
        ];
      };
    });
}
