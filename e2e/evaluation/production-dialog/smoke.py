"""Browser checks of the actual shared Modal/Surface/Notifications components."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

output = Path("work/ui-evaluation/production")
output.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height in [(1024, 700), (1366, 768)]:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        result = {"viewport": [width, height]}
        try:
            page.goto("http://127.0.0.1:1421/e2e/evaluation/production-dialog/index.html")
            page.wait_for_load_state("networkidle")
            trigger = page.get_by_role("button", name="Open editor", exact=True)
            trigger.click()
            dialog = page.get_by_role("dialog", name="Phrase editor", exact=True)
            expect(dialog).to_be_visible()
            expect(page.get_by_test_id("surfaces")).to_have_text("1")
            expect(page.get_by_test_id("blocked")).to_have_text("true")
            phrase = dialog.get_by_role("textbox", name="Phrase", exact=True)
            phrase.fill("寄り道のメモ")
            for _ in range(12):
                page.keyboard.press("Tab")
                page.wait_for_timeout(50)
                assert dialog.evaluate("el => el.contains(document.activeElement)"), "Tab escaped dialog"
            result["focus_contained"] = True
            phrase.focus()
            phrase.dispatch_event("compositionstart", {"data": "よ"})
            phrase.dispatch_event("keydown", {"key": "Escape", "code": "Escape", "isComposing": True, "keyCode": 229, "bubbles": True})
            expect(dialog).to_be_visible()
            phrase.dispatch_event("compositionend", {"data": "よ"})
            result["synthetic_ime_escape_retained"] = True
            dialog.get_by_role("checkbox", name="Lock dismissal").check()
            page.keyboard.press("Escape")
            page.mouse.click(5, 5)
            expect(dialog).to_be_visible()
            result["busy_dismissal_locked"] = True
            dialog.get_by_role("checkbox", name="Lock dismissal").uncheck()
            dialog.get_by_role("button", name="Notify", exact=True).click()
            expect(dialog.get_by_role("button", name="Draft retained", exact=True)).to_be_visible()
            nested_trigger = dialog.get_by_role("button", name="Open nested dialog", exact=True)
            nested_trigger.click()
            nested = page.get_by_role("dialog", name="Nested operation", exact=True)
            expect(nested).to_be_visible()
            expect(page.get_by_test_id("surfaces")).to_have_text("2")
            expect(nested.get_by_role("button", name="Draft retained", exact=True)).to_be_visible()
            page.keyboard.press("Escape")
            expect(nested).not_to_be_visible()
            expect(dialog).to_be_visible()
            expect(nested_trigger).to_be_focused()
            expect(dialog.get_by_role("button", name="Draft retained", exact=True)).to_be_visible()
            expect(phrase).to_have_value("寄り道のメモ")
            result["nested_escape_notification_focus"] = True
            page.screenshot(path=str(output / f"dialog-{width}.png"))
            page.keyboard.press("Escape")
            expect(dialog).not_to_be_visible()
            expect(trigger).to_be_focused()
            expect(page.get_by_test_id("surfaces")).to_have_text("0")
            result["escape_focus_restored"] = True
            trigger.click()
            expect(dialog).to_be_visible()
            page.mouse.click(5, 5)
            expect(dialog).not_to_be_visible()
            expect(trigger).to_be_focused()
            result["outside_click_dismissed"] = True
            assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "Horizontal overflow"
            result["no_horizontal_overflow"] = True
        except Exception as error:
            result["failure"] = str(error)
            page.screenshot(path=str(output / f"failure-{width}.png"))
        result["page_errors"] = errors
        results.append(result)
        page.close()
    browser.close()
(output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=True, indent=2))
assert all("failure" not in item and not item["page_errors"] for item in results), "Production dialog browser validation failed"
