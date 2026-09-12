# Retained ONNX Runtime overlay recipes

These files are unmodified `cmake/vcpkg-ports/` entries from Microsoft ONNX Runtime source commit `2e2543fbe9fae542f921d47a72d21d5a4ef0b710`, identified by the official 1.29.0 Windows archive's `GIT_COMMIT_ID`. Preserve upstream notices and the [ONNX Runtime MIT license](../../onnxruntime-LICENSE).

The official DLL's matching PDB records the vcpkg static library and header inputs. These overlay recipes describe source revisions and patches for that build; they are not a complete dependency archive or a redistribution approval. In particular, optional provider ports retained here are not evidence that those providers are present in the CPU DLL. The companion dependency inventory distinguishes observed binary inputs from the broader upstream source tree.

Source archive: https://codeload.github.com/microsoft/onnxruntime/tar.gz/2e2543fbe9fae542f921d47a72d21d5a4ef0b710

The upstream root .gitattributes is retained byte-for-byte as gitattributes.upstream so its patch-normalization rule cannot override this repository's exact-byte audit attributes. The original filename remains in the complete upstream source archive.
