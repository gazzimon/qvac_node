# Standalone `linux-x64` binaries register no CPU backend

Ready-to-file report. Everything below is measured on one machine, with the
discards listed so nobody repeats them.

## Summary

A `bare-build --standalone` binary for **linux-x64** that bundles
`@qvac/llm-llamacpp` **cannot load any model**. The same code, same machine,
same model file, run from source under the `bare` runtime, loads and answers
normally.

The packaged binary registers **only the Vulkan backend**. It never enumerates
the CPU backend variants, so with `--gpu-layers 0` — the recommended setting on
integrated GPUs — there is no device to place the weights on and the load aborts.

## Environment

| | |
| --- | --- |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-30-generic |
| CPU / GPU | AMD Ryzen (Rembrandt) + Radeon 680M, RADV, `uma: 1` |
| RAM | 25 GB, ~21 GB free |
| Node / npm | 22.22.1 / 11.19.1 |
| Model | `llama_3.2_1b_intruct_tool_calling_v2.Q4_K`, 807 691 648 B |

## Symptom

```
parse: load the model metadata from disk file.
ggml_vulkan: Found 1 Vulkan devices:
ggml_vulkan: 0 = AMD Radeon 680M (RADV REMBRANDT) (radv) | uma: 1 | ...
initFromConfig: load the model from disk file and apply lora adapter, if any.
common_fit_params: encountered an error while trying to fit params to free device memory: failed to load model
cmn  common_init_: failed to load model '.../llama_3.2_1b...Q4_K.gguf'
```

The `free device memory` wording is misleading: it is not a memory problem. The
inner error is `failed to load model`.

## The one difference

Same GGUF, same SHA256, same flags, same machine:

| runtime | result |
| --- | --- |
| `runtime: pear (installed)` — standalone binary | `failed to load model` |
| `runtime: bare (dev)` — `bare bin.mjs` from source | loads in 4.2 s, TTFT 0.07 s |

## Root observation (`strace -f -e trace=openat`)

Both runs probe the same generic backend names and get `ENOENT` for
`hexagon`, `musa`, `openvino` and the plain `cpu`. The difference is the CPU
**variants**:

| | generic names | the 14 variants (`cpu-haswell`, `cpu-zen4`, …) |
| --- | --- | --- |
| standalone | probed | **none** |
| from source | probed | **probed one by one; loads `haswell`** |

The variants can only come from listing the directory, and the standalone
**never opens it**:

```console
$ grep O_DIRECTORY /tmp/tr-bin.txt | grep llamacpp     # standalone
                                                        (no output)

$ grep O_DIRECTORY /tmp/tr-src.txt | grep llamacpp     # from source
... openat(AT_FDCWD, ".../prebuilds/linux-x64/qvac__llm-llamacpp",
      O_RDONLY|O_NONBLOCK|O_CLOEXEC|O_DIRECTORY) = 30      (x15)
```

The code path that enumerates the backends directory does not run inside the
packaged binary.

## Why linux only

`prebuilds/` ships different shapes per platform:

| platform | contents |
| --- | --- |
| `win32-x64` | `qvac__llm-llamacpp.bare` (+ `.exports`) — monolithic |
| `darwin-arm64` | `qvac__llm-llamacpp.bare` (+ `.exports`) — monolithic |
| `linux-x64` | `.bare` **plus a sibling directory with 15 `.so` files** |

Only Linux (and Android / linux-arm64) resolves backends as separate shared
libraries at runtime, so only Linux is affected.

## Ruled out, with evidence

- **Corrupted or truncated model.** Downloaded twice, 807 691 648 B both times.
  SHA256 `406bd5983096cc49e1019e9c295e1b011d7b17ccae9e066266eb1734a4743bf7`,
  byte-identical to the copy that loads fine on win32-x64.
- **Model-specific.** `smollm2-360m-instruct-q8_0` (386 MB, q8_0) fails
  identically. Two different quantizations.
- **GPU offload.** Fails with and without `--gpu-layers 0`, through two
  different code paths.
- **Vulkan / RADV.** With `VK_DRIVER_FILES=/nonexistent` the run prints
  `no usable GPU found` and fails identically — zero backends left.
- **Device memory.** iGPU carve-out is 5 GB (`mem_info_vram_total` =
  5368709120) with 21 GB RAM free, for an 808 MB model.
- **Context size.** Default is 2048.
- **Extraction / rename.** All 15 `.so` land in
  `/tmp/pyrusllm-<hash>/…/qvac__llm-llamacpp/` with clean names, correct sizes
  and `rw-rw-r--`.
- **`__dirname` / `backendsDir`.** The standalone probes the real `/tmp`
  extraction path, so `bare-build` does rewrite `__dirname` correctly.
- **`/tmp` mounted `noexec`.** It is `rw,nosuid,nodev`.
- **`GGML_BACKEND_PATH`.** No effect, pointing either at the `.so` directory or
  at its parent.

## Reproducing

```bash
npm run make                       # or download the released linux-x64 binary
./out/linux-x64/pyrusllm prompt "hello" --gpu-layers 0     # fails
npx bare bin.mjs prompt "hello" --gpu-layers 0             # works
```

## Impact

Every release publishes a `pyrusllm-linux-x64` artifact (269 MB in v0.12.0) and
the one-line installer installs it without warning. That artifact has never
served a token.
