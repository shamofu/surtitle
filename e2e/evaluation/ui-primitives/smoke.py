"""Run through with_server.py; records actual browser behavior, not a native HWND test."""
import json
import os
from pathlib import Path
from time import perf_counter
from playwright.sync_api import sync_playwright

output = Path(os.environ.get("EVALUATION_OUTPUT", "work/ui-evaluation/results"))
output.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name in ["current", "base", "aria", "radix"]:
        page = browser.new_page(viewport={"width": 1024, "height": 700}, reduced_motion="reduce")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        result = {"candidate": name}
        try:
            page.goto(f"http://127.0.0.1:1421/e2e/evaluation/ui-primitives/index.html?candidate={name}")
            page.wait_for_load_state("networkidle")
            result["loaded"] = page.get_by_role("heading", level=1).inner_text()
            trigger = page.get_by_role("button", name="Open dialog", exact=True)
            started = perf_counter()
            trigger.click()
            dialog = page.get_by_role("dialog", name="Phrase editor", exact=True)
            dialog.wait_for(state="visible")
            result["open_ms_single_sample"] = round((perf_counter() - started) * 1000, 2)
            phrase = page.get_by_role("textbox", name="Phrase", exact=True)
            phrase.fill("寄り道 — retained composition")
            result["input_retained"] = phrase.input_value() == "寄り道 — retained composition"
            page.get_by_role("tab", name="Source", exact=True).focus()
            page.keyboard.press("ArrowRight")
            page.wait_for_timeout(100)  # Allow each library's scheduled focus/activation.
            result["tabs_arrow_selected"] = page.get_by_role("tab", name="Notes", exact=True).get_attribute("aria-selected") == "true"
            trapped = True
            background_focused = False
            focus_targets = []
            for _ in range(12):
                page.keyboard.press("Tab")
                page.wait_for_timeout(100)
                trapped = trapped and dialog.evaluate("el => el.contains(document.activeElement)")
                background_focused = background_focused or page.evaluate("document.activeElement?.id === 'outside'")
                focus_targets.append(page.evaluate("({tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0,40)})"))
            result["tab_focus_contained"] = trapped
            result["tab_focus_avoids_background"] = not background_focused
            result["focus_targets"] = focus_targets
            phrase.focus()
            phrase.dispatch_event("compositionstart", {"data": "よ"})
            phrase.dispatch_event("keydown", {"key": "Escape", "code": "Escape", "isComposing": True, "keyCode": 229, "bubbles": True})
            result["synthetic_ime_escape_retained"] = dialog.is_visible()
            if dialog.is_visible():
                phrase.dispatch_event("compositionend", {"data": "よ"})
                page.screenshot(path=str(output / f"{name}-dialog.png"))
                page.keyboard.press("Escape")
                dialog.wait_for(state="hidden")
            result["dialog_escape_closes"] = not dialog.is_visible()
            page.wait_for_timeout(100)
            result["dialog_focus_restored"] = trigger.evaluate("el => el === document.activeElement")
            popover_trigger = page.get_by_text("Open popover", exact=True)
            popover_trigger.click()
            field = page.get_by_role("textbox", name="Filter", exact=True)
            field.wait_for(state="visible")
            field.fill("原文")
            page.keyboard.press("Escape")
            field.wait_for(state="hidden")
            page.wait_for_timeout(100)
            result["popover_escape_closes"] = not field.is_visible()
            result["popover_focus_restored"] = popover_trigger.evaluate("el => el === document.activeElement")
            result["horizontal_overflow"] = page.evaluate("document.documentElement.scrollWidth > innerWidth")
        except Exception as error:
            result["failure"] = str(error)
            page.screenshot(path=str(output / f"{name}-failure.png"))
        result["page_errors"] = errors
        results.append(result)
        page.close()
    browser.close()
(output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=True, indent=2))
