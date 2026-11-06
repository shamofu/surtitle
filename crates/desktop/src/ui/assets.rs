// SPDX-License-Identifier: GPL-3.0-or-later
use gpui_kit::{AssetSource, SharedString};
use std::borrow::Cow;

// Embed the application's original Lucide vocabulary alongside Kit's own
// control icons, without shipping the unused full icon catalog.
gpui_kit::assets::icon_assets!(
    ProductIcons,
    [
        Activity,
        Archive,
        ArrowDownToLine,
        ArrowLeft,
        AudioLines,
        BookmarkCheck,
        BookmarkPlus,
        BookOpen,
        Check,
        ChevronDown,
        ChevronLeft,
        ChevronRight,
        ChevronUp,
        Crosshair,
        Download,
        Ellipsis,
        Eye,
        FileText,
        FileVideoCamera,
        Gauge,
        Globe,
        Headphones,
        KeyRound,
        Languages,
        Layers,
        LibraryBig,
        Maximize,
        Minus,
        Moon,
        Pause,
        Pencil,
        Play,
        Plus,
        RefreshCw,
        Repeat,
        RotateCcw,
        RotateCw,
        Search,
        Settings2,
        SlidersHorizontal,
        Sparkles,
        Square,
        SquareCheck,
        Captions,
        Sun,
        Upload,
        Volume2,
        Wrench,
        X
    ]
);

pub(crate) struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = ProductIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }
    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(ProductIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
