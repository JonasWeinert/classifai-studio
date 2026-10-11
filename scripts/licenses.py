#!/usr/bin/env python3
"""Collect the open source licenses of everything ClassifAI Studio ships into src/licenses.json.

Covers the Rust crates the desktop app links on macOS (normal dependencies only, no dev or build
tools) and the frontend's production npm packages, plus bundled assets. Each package lists its
license and links; full license texts are stored once and shared by the packages that use them.

    python3 scripts/licenses.py     # rerun after changing dependencies
"""

import glob
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "licenses.json")
LICENSE_FILES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE")

texts: dict[str, int] = {}
text_list: list[str] = []


def license_text(directory: str) -> int | None:
    """Index of the package's license text(s), joined, in `text_list`."""
    if not directory or not os.path.isdir(directory):
        return None
    found = []
    for path in sorted(glob.glob(os.path.join(directory, "*"))):
        name = os.path.basename(path).upper()
        if os.path.isfile(path) and name.startswith(LICENSE_FILES):
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    found.append(f.read().strip())
            except OSError:
                pass
    if not found:
        return None
    text = "\n\n".join(found)
    # Copies of a license that differ only in whitespace (common for Apache-2.0) are stored once.
    key = " ".join(text.split())
    if key not in texts:
        texts[key] = len(text_list)
        text_list.append(text)
    return texts[key]


def rust_packages():
    host = next(l.split()[1] for l in subprocess.check_output(["rustc", "-vV"], text=True).splitlines() if l.startswith("host:"))
    meta = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--filter-platform", host, "--manifest-path", os.path.join(ROOT, "Cargo.toml")],
        text=True,
    ))
    pkgs = {p["id"]: p for p in meta["packages"]}
    members = set(meta["workspace_members"])
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = next(i for i in members if pkgs[i]["name"] == "classifai-desktop")
    seen, stack = set(), [root]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for d in nodes[cur]["deps"]:
            # Normal dependencies only: dev and build dependencies are not shipped.
            if any(k["kind"] is None for k in d["dep_kinds"]):
                stack.append(d["pkg"])
    out = []
    for i in seen - members:
        p = pkgs[i]
        out.append({
            "name": p["name"],
            "version": p["version"],
            "license": p.get("license") or ("see license file" if p.get("license_file") else "unknown"),
            "url": p.get("repository") or p.get("homepage") or f"https://crates.io/crates/{p['name']}",
            "text": license_text(os.path.dirname(p["manifest_path"])),
            "source": "Rust",
        })
    return out


def npm_packages():
    data = json.loads(subprocess.check_output(["pnpm", "licenses", "list", "--prod", "--json"], cwd=ROOT, text=True))
    out = []
    for license, items in data.items():
        for p in items:
            for version, path in zip(p["versions"], p["paths"]):
                out.append({
                    "name": p["name"],
                    "version": version,
                    "license": license,
                    "url": p.get("homepage") or f"https://www.npmjs.com/package/{p['name']}",
                    "text": license_text(path),
                    "source": "JavaScript",
                })
    return out


MIT_LOBEHUB = """MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."""


def assets():
    key = " ".join(MIT_LOBEHUB.split())
    if key not in texts:
        texts[key] = len(text_list)
        text_list.append(MIT_LOBEHUB)
    return [{
        "name": "LobeHub Icons (provider logos)",
        "version": "1.40.0",
        "license": "MIT",
        "url": "https://github.com/lobehub/lobe-icons",
        "text": texts[key],
        "source": "Assets",
        "note": "Logos are trademarks of their owners and identify the providers only.",
    }]


def main():
    packages = rust_packages() + npm_packages() + assets()
    packages.sort(key=lambda p: (p["name"].lower(), p["version"]))
    with open(OUT, "w") as f:
        json.dump({"packages": packages, "texts": text_list}, f, separators=(",", ":"))
    missing = sum(1 for p in packages if p["text"] is None)
    print(f"{len(packages)} packages, {len(text_list)} distinct license texts, {missing} without a license file -> {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
