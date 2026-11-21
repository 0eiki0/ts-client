# rnnoise-wasm

## web/rnnoise-v2.wasm (default, "strong")

The WebAssembly module embedded in `dist/rnnoise.js` of the npm package
[`@shiguredo/rnnoise-wasm`](https://github.com/shiguredo/rnnoise-wasm) 2025.1.5
(Apache-2.0, Copyright 2021-2025 Takeru Ohta, Shiguredo Inc.), extracted from its
base64 string. It is a build of current [RNNoise](https://github.com/xiph/rnnoise)
(0.2) including the newer, larger model, under the BSD license below.
Interface: imports `env.__assert_fail`, `env.emscripten_resize_heap`,
`wasi_snapshot_preview1.fd_write`; exports `rnnoise_create`,
`rnnoise_process_frame`, `malloc`, … (unminified).

## web/rnnoise.wasm ("light", for slow devices)

`web/rnnoise.wasm` is `dist/rnnoise.wasm` from the npm package
[`@jitsi/rnnoise-wasm`](https://github.com/jitsi/rnnoise-wasm) 0.2.1
(Apache-2.0, see `LICENSE`). It is a WebAssembly build of
[RNNoise](https://github.com/xiph/rnnoise), which is under the BSD 3-clause license:

```
Copyright (c) 2017, Mozilla
Copyright (c) 2007-2017, Jean-Marc Valin
Copyright (c) 2005-2017, Xiph.Org Foundation
Copyright (c) 2003-2004, Mark Borgerding

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of the Xiph.Org Foundation nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The module is used without the Emscripten JavaScript wrapper. Its minified
interface (see `web/audio-worklet.js`): imports `a.a` = `emscripten_resize_heap`,
`a.b` = `emscripten_memcpy_big`; exports `c` = memory, `d` = static constructors,
`f` = `rnnoise_create`, `g` = `malloc`, `h` = `rnnoise_destroy`, `i` = `free`,
`j` = `rnnoise_process_frame`.
