# Third-party notices

Goslynk Booster includes software from the projects below. Each keeps its own license, which
applies only to the parts that come from it.

## GamePingBooster

- Source: https://github.com/VietNguyenR/GamePingBooster
- Used in: `relay/` (relay server), `client-rs/crates/gpb-protocol` (wire protocol, ported to
  Rust), `testdata/` (protocol vectors), and game address data in `profiles/`.

```
MIT License

Copyright (c) 2026 Viet Nguyen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Wintun

- Source: https://www.wintun.net
- Used in: the Windows installer ships `wintun.dll` unmodified.
- License: prebuilt binaries, redistributable under the Wintun license
  (https://git.zx2c4.com/wintun/tree/prebuilt-binaries-license.txt).

## Rust crates and npm packages

The Rust crates listed in `client-rs/Cargo.lock` and the npm packages in
`client-rs/gpb-app/package-lock.json` and `backend/server/package.json` are used under their
own licenses (mostly MIT or Apache-2.0), as declared in each package.
