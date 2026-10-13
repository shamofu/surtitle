//! Device-local window placement. Learning backups and preference revisions do not include it.
use super::{Environment, invisible_insets, plan};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

fn window_state(window: &WebviewWindow) -> tauri::Result<(bool, bool)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsZoomed};
        let handle = window.hwnd()?.0;
        // The OS moves the maximized frame before Tauri receives WM_SIZE and
        // updates its cached flag. Never record that frame as normal bounds.
        Ok(unsafe { (IsIconic(handle) != 0, IsZoomed(handle) != 0) })
    }
    #[cfg(not(windows))]
    Ok((window.is_minimized()?, window.is_maximized()?))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    version: u8,
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    scale_factor: f64,
    maximized: bool,
}

impl Placement {
    fn validate(self) -> Result<Self> {
        ensure!(self.version == 1, "Unsupported window state version");
        ensure!(
            self.width.is_finite()
                && (1.0..=16384.0).contains(&self.width)
                && self.height.is_finite()
                && (1.0..=16384.0).contains(&self.height)
                && self.scale_factor.is_finite()
                && (0.5..=8.0).contains(&self.scale_factor),
            "Invalid window geometry"
        );
        Ok(self)
    }

    fn monitor(self, monitors: &[Environment]) -> Option<Environment> {
        // Origins remain physical on mixed-DPI desktops. Use the old physical
        // rectangle to find its monitor, then restore logical size at the new DPI.
        let left = f64::from(self.x);
        let top = f64::from(self.y);
        let right = left + self.width * self.scale_factor;
        let bottom = top + self.height * self.scale_factor;
        monitors
            .iter()
            .copied()
            .filter_map(|monitor| {
                let x = f64::from(monitor.origin.x);
                let y = f64::from(monitor.origin.y);
                let overlap = (right.min(x + f64::from(monitor.size.width)) - left.max(x)).max(0.0)
                    * (bottom.min(y + f64::from(monitor.size.height)) - top.max(y)).max(0.0);
                (overlap > 0.0).then_some((monitor, overlap))
            })
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(monitor, _)| monitor)
    }
}

pub(super) struct Persistence {
    path: PathBuf,
    placement: Option<Placement>,
    saved: Option<Placement>,
}

impl Persistence {
    pub(super) fn open(path: PathBuf) -> Self {
        let loaded = (|| -> Result<Option<Placement>> {
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            Ok(Some(
                serde_json::from_slice::<Placement>(&bytes)?.validate()?,
            ))
        })();
        let placement = match loaded {
            Ok(placement) => placement,
            Err(error) => {
                // Placement is optional and must never prevent access to learning data.
                eprintln!(
                    "Could not read window placement at {}: {error}",
                    path.display()
                );
                None
            }
        };
        Self {
            path,
            placement,
            saved: placement,
        }
    }

    pub(super) fn restore(&self, window: &WebviewWindow) -> Result<bool> {
        let Some(placement) = self.placement else {
            return Ok(false);
        };
        let environment = |monitor: tauri::Monitor| {
            let area = monitor.work_area();
            Environment {
                origin: area.position,
                size: area.size,
                scale: monitor.scale_factor(),
            }
        };
        let monitors = window
            .available_monitors()?
            .into_iter()
            .map(environment)
            .collect::<Vec<_>>();
        let Some(monitor) = placement
            .monitor(&monitors)
            .or(window.primary_monitor()?.map(environment))
            .or_else(|| monitors.first().copied())
        else {
            return Ok(false);
        };
        let inner = window.inner_size()?;
        let outer = window.outer_size()?;
        let frame_scale = monitor.scale / window.scale_factor()?;
        let requested = PhysicalSize::new(
            (placement.width * monitor.scale).round() as u32,
            (placement.height * monitor.scale).round() as u32,
        );
        let frame = PhysicalSize::new(
            (f64::from(outer.width.saturating_sub(inner.width)) * frame_scale).round() as u32,
            (f64::from(outer.height.saturating_sub(inner.height)) * frame_scale).round() as u32,
        );
        let fit = plan(
            monitor,
            requested,
            PhysicalSize::new(
                requested.width + frame.width,
                requested.height + frame.height,
            ),
            PhysicalPosition::new(placement.x, placement.y),
            invisible_insets(window).scaled(frame_scale),
        );
        window.set_position(fit.position)?;
        window.set_size(fit.size)?;
        Ok(placement.maximized)
    }

    pub(super) fn capture(&mut self, window: &WebviewWindow) -> tauri::Result<()> {
        let (minimized, maximized) = window_state(window)?;
        if minimized || window.is_fullscreen()? {
            return Ok(());
        }
        if maximized {
            if let Some(placement) = &mut self.placement {
                placement.maximized = true;
            }
        } else {
            let position = window.outer_position()?;
            let size = window.inner_size()?;
            let scale_factor = window.scale_factor()?;
            self.placement = Some(Placement {
                version: 1,
                x: position.x,
                y: position.y,
                width: f64::from(size.width) / scale_factor,
                height: f64::from(size.height) / scale_factor,
                scale_factor,
                maximized: false,
            });
        }
        Ok(())
    }

    pub(super) fn save(&mut self) -> Result<()> {
        if let Some(placement) = self.placement.filter(|value| Some(*value) != self.saved) {
            surtitle_core::store::write_json_atomic(&self.path, &placement).with_context(|| {
                format!("Could not save window placement at {}", self.path.display())
            })?;
            self.saved = Some(placement);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement() -> Placement {
        Placement {
            version: 1,
            x: -1800,
            y: 80,
            width: 1200.0,
            height: 750.0,
            scale_factor: 1.25,
            maximized: false,
        }
    }

    #[test]
    fn missing_invalid_and_future_placement_fall_back_without_altering_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window-state.json");
        assert!(Persistence::open(path.clone()).placement.is_none());
        for bytes in [
            b"invalid json".to_vec(),
            serde_json::to_vec(&Placement {
                version: 2,
                ..placement()
            })
            .unwrap(),
            serde_json::to_vec(&Placement {
                width: -1.0,
                ..placement()
            })
            .unwrap(),
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(Persistence::open(path.clone()).placement.is_none());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn negative_origin_and_changed_dpi_select_the_same_monitor() {
        let left = Environment {
            origin: PhysicalPosition::new(-1920, 0),
            size: PhysicalSize::new(1920, 1080),
            scale: 2.0,
        };
        let right = Environment {
            origin: PhysicalPosition::new(0, 0),
            ..left
        };
        assert_eq!(placement().monitor(&[right, left]), Some(left));
        assert_eq!(placement().monitor(&[right]), None);
        let requested = PhysicalSize::new(
            (placement().width * left.scale) as u32,
            (placement().height * left.scale) as u32,
        );
        let fitted = plan(
            left,
            requested,
            PhysicalSize::new(requested.width + 24, requested.height + 70),
            PhysicalPosition::new(placement().x, placement().y),
            super::super::Insets::default(),
        );
        assert!(fitted.size.width + 24 <= left.size.width);
        assert!(fitted.size.height + 70 <= left.size.height);
        assert_eq!(fitted.position, left.origin);
    }

    #[test]
    fn normal_bounds_and_maximized_state_round_trip_without_touching_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window-state.json");
        let preferences = directory.path().join("preferences.json");
        std::fs::write(&preferences, b"retained preferences").unwrap();
        let mut state = Persistence::open(path.clone());
        state.placement = Some(placement());
        state.save().unwrap();
        state.placement.as_mut().unwrap().maximized = true;
        state.save().unwrap();
        assert_eq!(
            Persistence::open(path).placement,
            Some(Placement {
                maximized: true,
                ..placement()
            })
        );
        assert_eq!(std::fs::read(preferences).unwrap(), b"retained preferences");
    }

    #[test]
    fn failed_save_does_not_acknowledge_unsaved_placement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("window-state.json");
        let mut state = Persistence::open(path.clone());
        state.placement = Some(placement());
        std::fs::create_dir(&path).unwrap();
        assert!(state.save().is_err());
        assert_eq!(state.saved, None);
        assert_eq!(state.placement, Some(placement()));
    }
}
