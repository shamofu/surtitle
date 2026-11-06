// SPDX-License-Identifier: GPL-3.0-or-later
//! Surtitle's native desktop host.
// Only Windows wires the production host. Other targets compile the shared
// services and GPUI components for tests; Windows CI still checks dead code.
#![cfg_attr(not(windows), allow(dead_code))]

mod application;
mod commands;
mod controller;
mod desktop;
mod player;
mod restore_snapshot;
mod runtime;
mod startup;
mod ui;

#[cfg(feature = "e2e-test")]
#[doc(hidden)]
pub mod native_host;

pub use desktop::run;
pub use startup::report_startup_failure;
