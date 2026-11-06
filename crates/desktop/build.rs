// SPDX-License-Identifier: GPL-3.0-or-later
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // GPUI's unoptimized view construction needs more than the PE linker's
        // default 1 MiB main-thread stack. Reserve virtual space; pages are
        // committed only as used. Worker stacks keep their runtime defaults.
        println!("cargo:rustc-link-arg-bin=surtitle=/STACK:8388608");
    }
}
