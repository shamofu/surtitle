//! Version-one device-local geometry, compatible with existing installations.
use super::geometry::PhysicalPosition;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Placement {
    pub(super) version: u8,
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) scale_factor: f64,
    pub(super) maximized: bool,
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

    pub(super) fn position(self) -> PhysicalPosition<i32> {
        PhysicalPosition::new(self.x, self.y)
    }
}

pub(super) struct Persistence {
    path: PathBuf,
    pub(super) placement: Option<Placement>,
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
            Ok(value) => value,
            Err(error) => {
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

    pub(super) fn capture(
        &mut self,
        normal: Option<Placement>,
        maximized: bool,
        minimized_or_fullscreen: bool,
    ) {
        if minimized_or_fullscreen {
            return;
        }
        if maximized {
            if let Some(placement) = &mut self.placement {
                placement.maximized = true;
            }
        } else if let Some(normal) = normal {
            self.placement = Some(normal);
        }
    }

    pub(super) fn save(&mut self) -> Result<()> {
        if let Some(value) = self.placement.filter(|value| Some(*value) != self.saved) {
            surtitle_core::store::write_json_atomic(&self.path, &value).with_context(|| {
                format!("Could not save window placement at {}", self.path.display())
            })?;
            self.saved = Some(value);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normal() -> Placement {
        Placement {
            version: 1,
            x: -1800,
            y: 80,
            width: 1200.,
            height: 750.,
            scale_factor: 1.25,
            maximized: false,
        }
    }

    #[test]
    fn existing_geometry_round_trips_and_system_states_preserve_normal_bounds() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("window-state.json");
        std::fs::write(&path, serde_json::to_vec(&normal()).unwrap()).unwrap();
        let mut persistence = Persistence::open(path.clone());
        persistence.capture(None, true, false);
        persistence.capture(
            Some(Placement {
                x: 0,
                y: 0,
                ..normal()
            }),
            false,
            true,
        );
        persistence.save().unwrap();
        assert_eq!(
            Persistence::open(path).placement,
            Some(Placement {
                maximized: true,
                ..normal()
            })
        );
    }

    #[test]
    fn invalid_or_future_geometry_never_prevents_startup_or_rewrites_the_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("window-state.json");
        for bytes in [
            b"broken".to_vec(),
            serde_json::to_vec(&Placement {
                version: 2,
                ..normal()
            })
            .unwrap(),
            serde_json::to_vec(&Placement {
                width: -1.,
                ..normal()
            })
            .unwrap(),
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(Persistence::open(path.clone()).placement.is_none());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn failed_save_keeps_pending_geometry_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("window-state.json");
        let mut persistence = Persistence::open(path.clone());
        persistence.capture(Some(normal()), false, false);
        std::fs::create_dir(&path).unwrap();
        assert!(persistence.save().is_err());
        assert_eq!(persistence.saved, None);
        assert_eq!(persistence.placement, Some(normal()));
    }
}
