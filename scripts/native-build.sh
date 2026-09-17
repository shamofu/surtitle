#!/usr/bin/env bash
# Run only inside native/build/Dockerfile. Outputs are never promoted implicitly.
set -euo pipefail
workspace=${1:-/workspace}
build_root=${2:-/build}
jobs=${SURTITLE_NATIVE_JOBS:-4}
source_root="$build_root/sources"
prefix="$build_root/prefix"
logs="$build_root/logs"
mkdir -p "$prefix" "$logs" "$build_root/objects"
python3 "$workspace/scripts/native-source-inputs.py" "$workspace" "$source_root"
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export CMAKE_PREFIX_PATH="$prefix"
export LIBRARY_PATH="$prefix/lib"
cross="$workspace/native/build/cross-win64.ini"
toolchain="$workspace/native/build/toolchain-win64.cmake"

meson_build() {
  local name=$1
  shift
  local output="$build_root/objects/$name"
  local reconfigure=()
  if [[ -f "$output/build.ninja" ]]; then reconfigure=(--reconfigure --clearcache); fi
    meson setup "${reconfigure[@]}" "$output" "$source_root/$name" --cross-file "$cross" \
      --prefix "$prefix" --libdir lib --buildtype release --wrap-mode nodownload \
      -Dauto_features=disabled -Ddefault_library=static -Dprefer_static=true "$@" 2>&1 | tee "$logs/$name-configure.log"
  meson compile -C "$output" -j "$jobs" 2>&1 | tee "$logs/$name-build.log"
  meson install -C "$output" --no-rebuild 2>&1 | tee "$logs/$name-install.log"
}
cmake_build() {
  local name=$1
  shift
  local output="$build_root/objects/$name"
  cmake -S "$source_root/$name" -B "$output" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_FIND_ROOT_PATH="$prefix" "$@" 2>&1 | tee "$logs/$name-configure.log"
  cmake --build "$output" --parallel "$jobs" 2>&1 | tee "$logs/$name-build.log"
  cmake --install "$output" 2>&1 | tee "$logs/$name-install.log"
}

meson_build dav1d -Denable_tools=false -Denable_tests=false
ffmpeg_output="$build_root/objects/ffmpeg"
mkdir -p "$ffmpeg_output"
if [[ ! -f "$ffmpeg_output/ffbuild/config.mak" ]] || ! grep -q '^CONFIG_LIBDAV1D=yes' "$ffmpeg_output/ffbuild/config.mak"; then
  (cd "$ffmpeg_output" && "$source_root/ffmpeg/configure" \
    --prefix="$prefix" --arch=x86_64 --target-os=mingw32 --enable-cross-compile \
    --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-gcc-posix \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --cxx=x86_64-w64-mingw32-g++-posix --enable-gpl --enable-version3 \
    --enable-static --disable-shared --disable-autodetect --disable-programs \
    --disable-doc --disable-debug --disable-network --disable-avdevice \
    --disable-encoders --disable-muxers --enable-w32threads --enable-libdav1d \
    --extra-cflags=-D_WIN32_WINNT=0x0A00 \
    --extra-ldflags="-L$prefix/lib -static-libgcc -static-libstdc++ -static") 2>&1 | tee "$logs/ffmpeg-configure.log"
fi
make -C "$ffmpeg_output" -j "$jobs" 2>&1 | tee "$logs/ffmpeg-build.log"
make -C "$ffmpeg_output" install 2>&1 | tee "$logs/ffmpeg-install.log"
meson_build freetype -Dzlib=internal -Dharfbuzz=disabled
meson_build harfbuzz -Dtests=disabled -Dutilities=disabled -Dsubset=disabled \
  -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dfreetype=enabled
meson_build fribidi -Ddocs=false -Dtests=false -Dbin=false
meson_build libass -Ddirectwrite=enabled -Dasm=enabled
cmake_build glslang -DENABLE_OPT=OFF -DENABLE_GLSLANG_BINARIES=OFF \
  -DENABLE_SPVREMAPPER=OFF -DENABLE_CTEST=OFF -DBUILD_TESTING=OFF \
  -DALLOW_EXTERNAL_SPIRV_TOOLS=OFF -DGLSLANG_TESTS=OFF -DENABLE_PCH=OFF
cmake_build spirv-cross -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF \
  -DSPIRV_CROSS_SHARED=OFF -DSPIRV_CROSS_STATIC=ON -DSPIRV_CROSS_ENABLE_HLSL=ON \
  -DSPIRV_CROSS_ENABLE_MSL=OFF -DSPIRV_CROSS_ENABLE_CPP=OFF \
  -DSPIRV_CROSS_ENABLE_REFLECT=OFF
# mpv probes this pkg-config name for its C API. Provide the same C API from
# exact static archives, with no DLL auto-export of compiler/pthread symbols.
spirv_cross_version=$(python3 -c 'import json,sys; print(next(s["pkgConfigVersion"] for s in json.load(open(sys.argv[1]))["sources"] if s["id"] == "spirv-cross"))' "$workspace/native/build/sources.json")
cat > "$prefix/lib/pkgconfig/spirv-cross-c-shared.pc" <<EOF
prefix=$prefix
Name: spirv-cross-c-shared
Description: SPIRV-Cross C API, statically linked by the Surtitle build recipe
Version: $spirv_cross_version
Libs: -L$prefix/lib -lspirv-cross-c -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core -lstdc++
Cflags: -I$prefix/include/spirv_cross
EOF
cmake_build shaderc -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
  -DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSPIRV_SKIP_TESTS=ON -DSPIRV_SKIP_EXECUTABLES=ON \
  -DSHADERC_GLSLANG_DIR="$source_root/glslang" \
  -DSHADERC_SPIRV_TOOLS_DIR="$source_root/spirv-tools" \
  -DSPIRV-Headers_SOURCE_DIR="$source_root/spirv-headers"
# mpv links with a C compiler. Keep the C++ runtime in the dependency group,
# after the combined shader compiler, rather than in early global linker flags.
sed -i '/^Libs:/ s/$/ -lstdc++/' "$prefix/lib/pkgconfig/shaderc_combined.pc"
meson_build libplacebo -Ddemos=false -Dtests=false -Dd3d11=enabled -Dglslang=enabled -Dvulkan-sdk="$prefix"
sed -i '/^Libs:/ s/$/ -lglslang-default-resource-limits/' "$prefix/lib/pkgconfig/libplacebo.pc"
meson_build mpv -Ddefault_library=shared -Dlibmpv=true -Dcplayer=false \
  -Dgpl=true -Dlua=disabled -Dgl=disabled -Dd3d11=enabled \
  -Dwasapi=enabled -Dwin32-threads=enabled -Dbuild-date=false -Dvector=enabled \
  -Dd3d-hwaccel=enabled -Djpeg=disabled -Dshaderc=enabled -Dspirv-cross=enabled

output="/out/native-build"
mkdir -p "$output/runtime" "$output/logs" "$output/toolchain-notices"
cp "$prefix/bin/libmpv-2.dll" "$output/runtime/"
if [[ -f "$output/runtime/libmpv-2.dll" ]]; then
  mv -- "$output/runtime/libmpv-2.dll" "$output/runtime/mpv-2.dll"
fi
cp -a "$logs/." "$output/logs/"
cp "$ffmpeg_output/config.h" "$ffmpeg_output/ffbuild/config.mak" "$output/logs/"
for project in dav1d freetype harfbuzz fribidi libass libplacebo mpv; do
  cp "$build_root/objects/$project/meson-info/intro-buildoptions.json" "$output/logs/$project-buildoptions.json"
  cp "$build_root/objects/$project/meson-info/intro-dependencies.json" "$output/logs/$project-dependencies.json"
done
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > "$output/toolchain-packages.tsv"
for package in gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix mingw-w64-common mingw-w64-x86-64-dev; do
  cp "/usr/share/doc/$package/copyright" "$output/toolchain-notices/$package-copyright"
done
sha256sum "$output/runtime/"*.dll > "$output/runtime-sha256.txt"
printf 'Build completed; run the separate review, promotion, PE and playback checks.\n'
