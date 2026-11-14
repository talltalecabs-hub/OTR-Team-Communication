#!/usr/bin/env python3
"""Local portal regression with an intercepted, stateful Supabase fixture.

No production connections or writes are made. Install Python Playwright and
Chromium; CHROMIUM_PATH overrides /usr/bin/chromium. OTR_TEST_OUTPUT retains
screenshots. Real PostgreSQL atomicity/RLS tests live in test_inventory_crew.mjs.
"""
import copy
import functools
import json
import os
import re
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("OTR_TEST_OUTPUT", tempfile.mkdtemp(prefix="otr-crew-check-")))
OUTPUT.mkdir(parents=True, exist_ok=True)


def uid(number):
    return f"00000000-0000-4000-8000-{number:012d}"


registry_source = (ROOT / "assets/core.js").read_text().split("const fallbackVehicleRegistry = ", 1)[1].split(";", 1)[0]
REGISTRY = json.loads(re.sub(r"([a-z_]+):", r'"\1":', registry_source))
CARTS = [
    {"cart_code": f"{code}-{letter}", "platform": platform, "cart_letter": letter}
    for platform, code in [("E92", "E92"), ("F22", "F22"), ("F30", "F30"), ("986 Boxster", "986")]
    for letter in ["A", "B"]
]


def make_bin(number, code, model, name, cart=None, parent=None):
    return dict(id=uid(number), bin_code=code, model=model, make="Porsche" if model == "986 Boxster" else "BMW",
                make_prefix="P" if model == "986 Boxster" else "B", system=name, description=name,
                cart_location=cart, parent_bin_id=parent, label_format="4x6", status="Active")


def make_item(number, code, name, platform="E92", quantity=3, bin_id=None, cart=None, stock="Mobile", unit="pcs"):
    physical_bin = next((row for row in INITIAL_BINS if row["id"] == bin_id), None)
    return dict(id=uid(number), inventory_code=code, item_name=name, platform=platform, quantity=quantity,
                inventory_bin_id=bin_id, cart_code=cart, stock_category=stock, quantity_unit=unit,
                location=physical_bin["bin_code"] if physical_bin else ("Backstock" if stock == "Backstock" else "Unassigned"),
                category="Cooling" if platform == "E92" else "Spares", condition="New", status="In Stock" if quantity else ("Uncounted" if quantity is None else "Out of Stock"),
                verification_status="Imported", compatibility=[platform], assignment_type="General Inventory",
                assigned_vehicle=None, assigned_vehicle_code=None, tag_id=None, source="Crew browser fixture",
                source_metadata={"source_row": number, "quantity_raw": "VARIOUS" if quantity is None else quantity, "label_text": name.upper()},
                original_quantity=quantity, original_location=physical_bin["bin_code"] if physical_bin else "Unassigned",
                original_item_text=name, updated_at="2026-11-14T00:00:00Z")


INITIAL_BINS = [
    make_bin(200, "E92-000", "E92", "Loose inventory"),
    make_bin(208, "E92-008", "E92", "Cooling system", "A"),
    make_bin(218, "E92-018", "E92", "Sensors / seals", "A"),
    make_bin(219, "E92-018-A", "E92", "Sensors", "A", uid(218)),
    make_bin(220, "E92-018-B", "E92", "Seals", "A", uid(218)),
    make_bin(221, "E92-019", "E92", "Exhaust", "B"),
    make_bin(222, "E92-022", "E92", "Uncounted stock", "B"),
    make_bin(230, "F22-000", "F22", "Loose inventory"),
    make_bin(231, "F22-001", "F22", "Right rear knuckle"),
    make_bin(240, "F30-000", "F30", "Loose inventory"),
    make_bin(241, "F30-001", "F30", "Brake spares", "A"),
    make_bin(242, "F30-002", "F30", "Cooling & hoses", "B"),
    make_bin(250, "986-000", "986 Boxster", "Loose inventory"),
]
INITIAL_ITEMS = [
    make_item(1, "E92-KNOWN", "Coolant temperature sensor", bin_id=uid(208)),
    make_item(2, "E92-UNKNOWN", "Uncounted hardware", quantity=None, bin_id=uid(208)),
    make_item(3, "E92-ZERO", "Empty coolant gasket lot", quantity=0, bin_id=uid(208)),
    make_item(4, "E92-FLAGS", "Seal set", quantity=6, bin_id=uid(219), unit="sets"),
    make_item(5, "F22-SENSOR", "F22 wheel sensor", platform="F22", quantity=2, bin_id=uid(231)),
    make_item(6, "F30-RETRY", "Retry-safe brake pads", platform="F30", quantity=4, bin_id=uid(241)),
    make_item(7, "F30-LOOSE-A", "Loose rotor A", platform="F30", quantity=1, bin_id=uid(240), cart="F30-A"),
    make_item(8, "F30-LOOSE-B", "Loose rotor B", platform="F30", quantity=2, bin_id=uid(240), cart="F30-B"),
    make_item(9, "SHOP-01", "Shop hose stock", quantity=8, stock="Backstock"),
]
# Misleading text must never make a part appear in the wrong bin's contents.
INITIAL_ITEMS[3]["location"] = "E92-008"


class FixtureError(Exception):
    pass


class Backend:
    def __init__(self):
        self.items = copy.deepcopy(INITIAL_ITEMS)
        self.bins = copy.deepcopy(INITIAL_BINS)
        self.events = []
        self.submissions = []
        self.attempts = []
        self.writes = []
        self.errors = []
        self.use_requests = {}
        self.offline_submissions = False
        self.lose_next_use_response = False
        self.hold_next_use_response = False
        self.held_use_response = None
        self.next_number = 1000

    def new_id(self):
        self.next_number += 1
        return uid(self.next_number)

    def item(self, code):
        return next(row for row in self.items if row["inventory_code"] == code)

    def find_item(self, item_id):
        result = next((row for row in self.items if row["id"] == item_id), None)
        if not result:
            raise FixtureError("Inventory item not found")
        return result

    def event(self, kind, actor, before, after, vehicle=None, delta=None, request_id=None):
        subject = after or before
        is_item = "inventory_code" in subject
        bin_id = subject.get("inventory_bin_id") if is_item else subject.get("id")
        physical_bin = next((physical for physical in self.bins if physical["id"] == bin_id), None)
        bin_code = physical_bin["bin_code"] if physical_bin else subject.get("bin_code")
        cart_code = subject.get("cart_code")
        if physical_bin and physical_bin.get("cart_location") and not physical_bin["bin_code"].endswith("-000"):
            chassis = "986" if physical_bin["model"] == "986 Boxster" else physical_bin["model"]
            cart_code = chassis + "-" + physical_bin["cart_location"]
        if is_item and subject.get("stock_category") == "Backstock":
            cart_code = None
        row = dict(id=self.new_id(), event_type=kind, actor_initials=actor,
                   inventory_item_id=subject.get("id") if is_item else None,
                   inventory_code=subject.get("inventory_code"), bin_id=bin_id,
                   bin_code=bin_code, cart_code=cart_code, vehicle_code=vehicle,
                   quantity_delta=delta, quantity_before=before.get("quantity") if before else None,
                   quantity_after=after.get("quantity") if after else None, from_state=copy.deepcopy(before),
                   to_state=copy.deepcopy(after), request_id=request_id, created_at="2026-11-14T12:00:00Z", source="portal")
        self.events.append(row)
        return row

    def classify(self, before, after):
        if before is None:
            return "add_stock"
        if before.get("quantity") != after.get("quantity"):
            return "quantity_corrected"
        if before.get("stock_category") != after.get("stock_category"):
            return "stock_category_changed"
        if any(before.get(key) != after.get(key) for key in ["inventory_bin_id", "cart_code", "platform"]):
            return "bin_assigned"
        if before.get("verification_status") != after.get("verification_status") or before.get("status") != after.get("status"):
            return "verification_changed"
        if before.get("reorder_flag") != after.get("reorder_flag"):
            return "reorder_flag_changed"
        return "metadata_changed"

    def actor(self, request, data):
        actor = request.headers.get("x-otr-initials", "").strip().upper()
        if not actor or len(actor) > 8:
            raise FixtureError("Initials are required")
        if request.headers.get("x-otr-initials") != actor:
            raise FixtureError("Initials must be normalized before sending")
        if data.get("p_actor_initials") is not None and data["p_actor_initials"] != actor:
            raise FixtureError("RPC initials must match request initials")
        return actor

    def use(self, data, actor):
        item = self.find_item(data.get("p_item_id"))
        quantity = data.get("p_quantity")
        vehicle = data.get("p_vehicle_code")
        request_id = data.get("p_request_id")
        if not any(row["vehicle_code"] == vehicle for row in REGISTRY):
            raise FixtureError("Choose an exact vehicle")
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 1:
            raise FixtureError("Quantity must be a positive whole number")
        if not request_id:
            raise FixtureError("Request identity is required")
        identity = (item["id"], vehicle, quantity, actor)
        if request_id in self.use_requests:
            previous, response = self.use_requests[request_id]
            if previous != identity:
                raise FixtureError("Request identity was reused with different inputs")
            return dict(response, replayed=True)
        if item["quantity"] is not None and quantity > item["quantity"]:
            raise FixtureError("Insufficient inventory")
        before = copy.deepcopy(item)
        if item["quantity"] is not None:
            item["quantity"] -= quantity
            if item["quantity"] == 0:
                item["status"] = "Out of Stock"
        item["updated_at"] = "2026-11-14T12:00:00Z"
        event = self.event("use_part", actor, before, item, vehicle, -quantity, request_id)
        response = dict(event_id=event["id"], item_id=item["id"], quantity_before=before["quantity"],
                        quantity_after=item["quantity"], quantity_used=quantity, vehicle_code=vehicle,
                        actor_initials=actor, replayed=False)
        self.use_requests[request_id] = (identity, response)
        return response

    def move(self, data, actor):
        item = self.find_item(data.get("p_item_id"))
        quantity = data.get("p_quantity")
        category = data.get("p_stock_category")
        chassis = data.get("p_chassis")
        cart = data.get("p_cart_code")
        target_bin = next((row for row in self.bins if row["id"] == data.get("p_bin_id")), None)
        if category not in ["Mobile", "Backstock"]:
            raise FixtureError("Choose an inventory type")
        if category == "Mobile" and not chassis:
            raise FixtureError("Choose a chassis")
        if item["quantity"] is None:
            raise FixtureError("Count this item before moving it")
        if not isinstance(quantity, int) or quantity < 1 or quantity > item["quantity"]:
            raise FixtureError("Invalid move quantity")
        if cart and not any(row["cart_code"] == cart and row["platform"] == chassis for row in CARTS):
            raise FixtureError("Cart must match chassis")
        if target_bin and chassis and target_bin["model"] != chassis:
            raise FixtureError("Bin must match chassis")
        loose = bool(target_bin and target_bin["bin_code"].endswith("-000"))
        if category == "Backstock" and (cart or (target_bin and target_bin.get("cart_location"))):
            raise FixtureError("Backstock cannot be placed on a mobile cart")
        if target_bin and not loose:
            prefix = "986" if target_bin["model"] == "986 Boxster" else target_bin["model"]
            inherited = f"{prefix}-{target_bin['cart_location']}" if target_bin.get("cart_location") else None
            if cart and cart != inherited:
                raise FixtureError("Bin and cart conflict")
            cart = None
        before = copy.deepcopy(item)
        split = quantity < item["quantity"]
        if split:
            item["quantity"] -= quantity
            self.event("move_inventory", actor, before, item, delta=-quantity, request_id=data.get("p_request_id"))
            moved = copy.deepcopy(before)
            moved.update(id=self.new_id(), inventory_code=before["inventory_code"] + "-SPLIT", quantity=quantity, tag_id=None)
            self.items.append(moved)
            moved_before = None
        else:
            moved = item
            moved_before = before
        moved.update(stock_category=category, platform=chassis or before["platform"], inventory_bin_id=target_bin["id"] if target_bin else None,
                     location=target_bin["bin_code"] if target_bin else ("Backstock" if category == "Backstock" else cart or "Unassigned"),
                     cart_code=cart if category == "Mobile" else None, reorder_flag=bool(data.get("p_reorder_flag")))
        self.event("move_inventory", actor, moved_before, moved, delta=quantity if split else 0, request_id=data.get("p_request_id"))
        return dict(item_id=moved["id"], split=split)

    def release_held_use(self):
        assert self.held_use_response is not None
        route, result = self.held_use_response
        self.held_use_response = None
        route.fulfill(status=200, content_type="application/json", body=json.dumps(result),
                      headers={"access-control-allow-origin": "*"})

    def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        path = parsed.path.split("/rest/v1/", 1)[-1]
        query = parse_qs(parsed.query)
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH"})
            return
        if self.offline_submissions and path == "submissions":
            route.abort("internetdisconnected")
            return
        data = request.post_data_json if request.method in ["POST", "PATCH"] else {}
        data = data or {}
        inventory_mutation = request.method != "GET" and (path.startswith("inventory_") or path.startswith("rpc/"))
        try:
            actor = None
            if inventory_mutation:
                self.attempts.append(dict(path=path, method=request.method, data=copy.deepcopy(data), headers=dict(request.headers)))
                actor = self.actor(request, data)
            if path == "vehicles" and request.method == "GET":
                result = REGISTRY
            elif path == "inventory_carts" and request.method == "GET":
                result = CARTS
            elif path == "inventory_events":
                if request.method != "GET":
                    raise FixtureError("Inventory events are append-only")
                result = list(reversed(self.events))
            elif path == "inventory_items":
                if request.method == "GET":
                    result = sorted(self.items, key=lambda row: row["item_name"])
                elif request.method == "POST":
                    item = copy.deepcopy(data)
                    item["id"] = self.new_id()
                    self.items.append(item)
                    self.event("add_stock", actor, None, item, delta=item.get("quantity"))
                    result = [item]
                elif request.method == "PATCH":
                    item_id = query.get("id", [""])[0].removeprefix("eq.")
                    item = self.find_item(item_id)
                    before = copy.deepcopy(item)
                    item.update(copy.deepcopy(data))
                    old_quantity, new_quantity = before.get("quantity"), item.get("quantity")
                    delta = new_quantity - old_quantity if old_quantity is not None and new_quantity is not None else None
                    self.event(self.classify(before, item), actor, before, item, delta=delta)
                    result = [item]
                else:
                    raise FixtureError("Unexpected inventory item method")
            elif path == "inventory_bins":
                if request.method == "GET":
                    result = sorted(self.bins, key=lambda row: row["bin_code"])
                elif request.method == "POST":
                    physical_bin = dict(copy.deepcopy(data), id=self.new_id())
                    self.bins.append(physical_bin)
                    self.event("bin_created", actor, None, physical_bin)
                    result = [physical_bin]
                elif request.method == "PATCH":
                    bin_id = query.get("id", [""])[0].removeprefix("eq.")
                    physical_bin = next(row for row in self.bins if row["id"] == bin_id)
                    before = copy.deepcopy(physical_bin)
                    physical_bin.update(copy.deepcopy(data))
                    self.event("bin_moved", actor, before, physical_bin)
                    result = [physical_bin]
                else:
                    raise FixtureError("Unexpected bin method")
            elif path == "rpc/use_inventory_part" and request.method == "POST":
                result = self.use(data, actor)
                if self.lose_next_use_response:
                    self.lose_next_use_response = False
                    self.writes.append(self.attempts[-1])
                    route.abort("connectionreset")
                    return
                if self.hold_next_use_response:
                    self.hold_next_use_response = False
                    self.held_use_response = (route, result)
                    self.writes.append(self.attempts[-1])
                    return
            elif path == "rpc/move_inventory_part" and request.method == "POST":
                result = self.move(data, actor)
            elif path == "submissions":
                if request.method == "POST":
                    self.submissions.append(dict(copy.deepcopy(data), id=self.new_id()))
                result = self.submissions
            else:
                self.errors.append(f"Unexpected API route: {request.method} {path}")
                raise FixtureError("Unexpected API route")
            if inventory_mutation:
                self.writes.append(self.attempts[-1])
            route.fulfill(status=200, content_type="application/json", body=json.dumps(result), headers={"access-control-allow-origin": "*"})
        except FixtureError as error:
            route.fulfill(status=400, content_type="application/json", body=json.dumps({"message": str(error)}), headers={"access-control-allow-origin": "*"})
        except Exception as error:
            self.errors.append(repr(error))
            route.fulfill(status=500, content_type="application/json", body=json.dumps({"message": str(error)}))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def fields(page):
    return page.locator("#inventoryDetailWrap .inventory-field").evaluate_all(
        "(els)=>Object.fromEntries(els.map(e=>[e.querySelector('.k').textContent,e.querySelector('.v').textContent.trim()]))"
    )


def assert_handlers(page):
    missing = page.evaluate(r"""() => [...document.querySelectorAll('*')].flatMap(e=>[...e.attributes]
      .filter(a=>/^on/.test(a.name)).flatMap(a=>[...a.value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
      .map(m=>m[1]))).filter(n=>typeof window[n]!=='function')""")
    assert not missing, missing


def assert_no_request(backend, action):
    before = len(backend.attempts)
    action()
    assert len(backend.attempts) == before, backend.attempts[before:]


def open_item(page, code):
    page.evaluate("(code)=>openInventoryDetail(code)", code)
    page.wait_for_selector("#inventoryDetail.active")


def open_management(page, code):
    open_item(page, code)
    page.evaluate("openInventoryItemManagement()")
    page.wait_for_selector("#inventoryItemManagement.active")
    assert page.locator("#inventoryActionInitials").is_visible()
    assert page.input_value("#inventoryActionInitials") == ""


def open_use(page, code):
    open_item(page, code)
    page.evaluate("openUsePart()")
    page.wait_for_selector("#inventoryUsePart.active")
    assert page.input_value("#usePartQty") == "1"
    assert page.locator("#usePartInitials").is_visible()
    assert page.input_value("#usePartInitials") == ""


def run_checks(page, backend):
    page.goto(base_url)
    page.wait_for_function("vehicleRegistryReady")
    assert len(REGISTRY) == page.evaluate("vehicleRegistry.length") == 23
    assert_handlers(page)

    # The primary crew entry is search-first, while administrative tools are one level deeper.
    page.locator("#homeInventoryButton").click()
    page.wait_for_selector("#inventoryHome.active")
    landing = page.locator("#inventoryHome .bigbtn").all_text_contents()
    assert len(landing) == 2, landing
    assert "Mobile Inventory Search" in landing[0] and "Inventory Management" in landing[1], landing
    for hidden_action in ["Backstock", "Search All Inventory", "Add Inventory Item", "Label & Bin Assistant"]:
        assert not any(text.strip().startswith(hidden_action) for text in landing)
    page.locator("#inventoryHome .bigbtn").nth(1).click()
    page.wait_for_selector("#inventoryManagement.active")
    management_text = page.locator("#inventoryManagement").inner_text()
    assert all(label in management_text for label in ["Backstock", "Search All", "Add", "Bin", "Move"]), management_text
    page.evaluate("openInventoryAssistant()")
    page.locator("#crewMobileSearchButton").click()
    page.wait_for_selector("#inventoryBrowse.active")
    page.wait_for_function("inventoryBackendReady && inventoryBinsReady && inventoryCartsReady")
    assert page.input_value("#inventoryStockCategoryFilter") == "Mobile"
    assert "Shop hose stock" not in page.locator("#inventoryResults").inner_text()
    assert page.locator("#inventorySearch").is_visible()
    page.fill("#inventorySearch", "F30-B loose")
    cart_search = page.locator("#inventoryResults").inner_text()
    assert "Loose rotor B" in cart_search and "Loose rotor A" not in cart_search, cart_search
    page.fill("#inventorySearch", "E92-A sensor")
    assert "Coolant temperature sensor" in page.locator("#inventoryResults").inner_text()
    page.fill("#inventorySearch", "E92-008")
    assert "Coolant temperature sensor" in page.locator("#inventoryResults").inner_text()
    page.fill("#inventorySearch", "Coolant temperature sensor")
    card = page.locator("#inventoryResults .inventory-card")
    assert card.count() == 1
    physical_lines = card.locator(":scope > .meta").all_text_contents()
    assert any("E92-A" in line and "E92-008" in line and "•" in line for line in physical_lines), physical_lines
    card.click()
    page.wait_for_selector("#inventoryDetail.active")
    detail_fields = fields(page)
    path_keys = [key for key in detail_fields if key.strip().upper() == "LOCATION / BIN"]
    assert len(path_keys) == 1 and "E92-A" in detail_fields[path_keys[0]] and "E92-008" in detail_fields[path_keys[0]], detail_fields
    assert not any(key.strip().lower() in ["location", "bin"] for key in detail_fields)
    assert "Use Part" in page.locator("#inventoryDetail .actions").inner_text()
    assert "Verify / Correct" not in page.locator("#inventoryDetail .actions").inner_text()
    assert_handlers(page)

    # Use Part: exact vehicle registry, mandatory initials, quantity one by default.
    original = copy.deepcopy(backend.item("E92-KNOWN"))
    page.evaluate("openUsePart()")
    page.wait_for_selector("#inventoryUsePart.active")
    assert page.input_value("#usePartQty") == "1"
    options = page.locator("#usePartVehicle option").evaluate_all("els=>els.map(e=>e.value).filter(Boolean)")
    assert "E92-CHERRY" in options and "F30-GOLDIE" not in options, options
    assert set(options).issubset({row["vehicle_code"] for row in REGISTRY})
    page.check("#showAllUseVehicles")
    all_options = page.locator("#usePartVehicle option").evaluate_all("els=>els.map(e=>e.value).filter(Boolean)")
    assert set(all_options) == {row["vehicle_code"] for row in REGISTRY}, all_options
    page.uncheck("#showAllUseVehicles")
    assert_no_request(backend, lambda: page.evaluate("finishUsePart()"))
    page.select_option("#usePartVehicle", "E92-CHERRY")
    page.fill("#usePartInitials", "   ")
    assert_no_request(backend, lambda: page.evaluate("finishUsePart()"))
    page.fill("#usePartInitials", " jd ")
    page.fill("#usePartQty", "1.5")
    assert_no_request(backend, lambda: page.evaluate("finishUsePart()"))
    page.fill("#usePartQty", "99")
    assert_no_request(backend, lambda: page.evaluate("finishUsePart()"))
    page.fill("#usePartQty", "1")
    before_use_requests = len([request for request in backend.attempts if request["path"] == "rpc/use_inventory_part"])
    page.evaluate("Promise.all([finishUsePart(),finishUsePart()])")
    page.wait_for_selector("#inventoryUseSuccess.active")
    assert len([request for request in backend.attempts if request["path"] == "rpc/use_inventory_part"]) == before_use_requests + 1
    used = backend.item("E92-KNOWN")
    assert used["quantity"] == 2 and backend.events[-1]["event_type"] == "use_part"
    assert backend.events[-1]["actor_initials"] == "JD" and backend.events[-1]["vehicle_code"] == "E92-CHERRY"
    assert "2" in page.locator("#usePartConfirmation").inner_text()
    for key, value in original.items():
        if key not in ["quantity", "status", "updated_at"]:
            assert used[key] == value, key

    page.locator("#useAnotherPartButton").click()
    page.wait_for_selector("#inventoryBrowse.active")
    assert page.input_value("#inventoryStockCategoryFilter") == "Mobile"

    # Deplete known stock, while uncounted stock remains NULL and keeps its placement.
    open_use(page, "E92-KNOWN")
    page.select_option("#usePartVehicle", "E92-CHERRY")
    page.fill("#usePartQty", "2")
    page.fill("#usePartInitials", "jd")
    page.evaluate("finishUsePart()")
    assert backend.item("E92-KNOWN")["quantity"] == 0 and backend.item("E92-KNOWN")["status"] == "Out of Stock"
    zero_events = len(backend.events)
    open_item(page, "E92-KNOWN")
    page.evaluate("openUsePart()")
    if page.locator("#inventoryUsePart.active").count():
        page.select_option("#usePartVehicle", "E92-CHERRY")
        page.fill("#usePartInitials", "jd")
        page.evaluate("finishUsePart()")
    assert backend.item("E92-KNOWN")["quantity"] == 0 and len(backend.events) == zero_events

    unknown_before = copy.deepcopy(backend.item("E92-UNKNOWN"))
    open_use(page, "E92-UNKNOWN")
    page.select_option("#usePartVehicle", "E92-CHERRY")
    page.fill("#usePartInitials", "ab")
    page.evaluate("finishUsePart()")
    assert backend.item("E92-UNKNOWN")["quantity"] is None
    assert "uncounted" in page.locator("#usePartConfirmation").inner_text().lower()
    assert backend.events[-1]["quantity_before"] is None and backend.events[-1]["quantity_after"] is None
    for key in ["inventory_bin_id", "cart_code", "platform", "stock_category", "assignment_type", "source_metadata"]:
        assert backend.item("E92-UNKNOWN")[key] == unknown_before[key], key
    page.evaluate('openAssignPartToBin("","E92-UNKNOWN")')
    page.fill("#assignPartQty", "1")
    page.fill("#assignPartInitials", "un")
    assert_no_request(backend, lambda: page.evaluate("assignSelectedPartToBin()"))
    assert backend.item("E92-UNKNOWN")["quantity"] is None

    # F22 uses the existing M235 registry identities rather than inventing F22 cars.
    open_use(page, "F22-SENSOR")
    f22_options = page.locator("#usePartVehicle option").evaluate_all("els=>els.map(e=>e.value).filter(Boolean)")
    assert "M235-RAPTOR" in f22_options and "M235-TRIXIE" in f22_options
    assert "E92-CHERRY" not in f22_options

    # Completing a pending use must not overwrite a different item opened meanwhile.
    page.select_option("#usePartVehicle", "M235-RAPTOR")
    page.fill("#usePartInitials", "nav")
    other_item_before = copy.deepcopy(backend.item("E92-FLAGS"))
    backend.hold_next_use_response = True
    with page.expect_request("**/rpc/use_inventory_part"):
        page.evaluate("() => { window.pendingUseNavigation = finishUsePart(); }")
    open_item(page, "E92-FLAGS")
    assert backend.held_use_response is not None
    assert page.evaluate("currentInventoryItem.inventory_code") == "E92-FLAGS"
    backend.release_held_use()
    page.evaluate("window.pendingUseNavigation")
    assert page.locator("#inventoryDetail.active").count() == 1
    assert page.evaluate("currentInventoryItem.inventory_code") == "E92-FLAGS"
    assert backend.item("E92-FLAGS") == other_item_before
    assert backend.item("F22-SENSOR")["quantity"] == 1
    assert backend.events[-1]["inventory_code"] == "F22-SENSOR" and backend.events[-1]["actor_initials"] == "NAV"

    # Simulate an applied operation whose response is lost. Retry must use the same identity.
    open_use(page, "F30-RETRY")
    page.select_option("#usePartVehicle", "F30-GOLDIE")
    page.fill("#usePartInitials", "rt")
    backend.lose_next_use_response = True
    page.evaluate("finishUsePart()")
    assert backend.item("F30-RETRY")["quantity"] == 3
    first_attempt = copy.deepcopy(backend.attempts[-1]["data"])
    event_count = len(backend.events)
    page.evaluate("finishUsePart()")
    assert backend.item("F30-RETRY")["quantity"] == 3 and len(backend.events) == event_count
    assert backend.attempts[-1]["data"]["p_request_id"] == first_attempt["p_request_id"]
    page.wait_for_selector("#inventoryUseSuccess.active")

    # Management flags and stock-category changes require a fresh visible initials box.
    open_item(page, "E92-FLAGS")
    subbin_path = next(value for key, value in fields(page).items() if key.strip().upper() == "LOCATION / BIN")
    assert "E92-A" in subbin_path and "E92-018-A" in subbin_path and "E92-008" not in subbin_path, subbin_path
    open_management(page, "E92-FLAGS")
    assert_no_request(backend, lambda: page.evaluate("markInventoryNeedsReview()"))
    page.fill("#inventoryActionInitials", "rv")
    page.evaluate("markInventoryNeedsReview()")
    assert backend.item("E92-FLAGS")["verification_status"] == "Needs Review"
    assert backend.events[-1]["event_type"] == "verification_changed"
    open_management(page, "E92-FLAGS")
    assert_no_request(backend, lambda: page.evaluate("markInventoryNotFound()"))
    page.fill("#inventoryActionInitials", "nf")
    page.evaluate("markInventoryNotFound()")
    assert backend.item("E92-FLAGS")["status"] == "Missing"
    quantity_before = backend.item("E92-FLAGS")["quantity"]
    open_management(page, "E92-FLAGS")
    assert_no_request(backend, lambda: page.evaluate('changeInventoryStockCategory("Backstock")'))
    page.fill("#inventoryActionInitials", "bs")
    page.evaluate('changeInventoryStockCategory("Backstock")')
    assert backend.item("E92-FLAGS")["stock_category"] == "Backstock" and backend.item("E92-FLAGS")["quantity"] == quantity_before
    open_management(page, "E92-FLAGS")
    page.fill("#inventoryActionInitials", "mb")
    page.evaluate('changeInventoryStockCategory("Mobile")')

    # A physical correction is a different event from consumption, including NULL -> counted.
    open_item(page, "E92-FLAGS")
    page.evaluate("openInventoryVerify()")
    page.fill("#invQty", "5")
    assert_no_request(backend, lambda: page.evaluate("saveInventoryVerification()"))
    page.fill("#invInitials", "ct")
    page.fill("#invQty", "-1")
    assert_no_request(backend, lambda: page.evaluate("saveInventoryVerification()"))
    page.fill("#invQty", "5")
    page.evaluate("saveInventoryVerification()")
    assert backend.item("E92-FLAGS")["quantity"] == 5
    assert backend.events[-1]["event_type"] == "quantity_corrected" and backend.events[-1]["quantity_delta"] == -1
    open_item(page, "E92-UNKNOWN")
    page.evaluate("openInventoryVerify()")
    assert page.input_value("#invQty") == ""
    page.fill("#invInitials", "pc")
    page.evaluate("saveInventoryVerification()")
    assert backend.item("E92-UNKNOWN")["quantity"] is None
    open_item(page, "E92-UNKNOWN")
    page.evaluate("openInventoryVerify()")
    page.fill("#invQty", "4")
    page.fill("#invInitials", "pc")
    page.evaluate("saveInventoryVerification()")
    assert backend.events[-1]["quantity_before"] is None and backend.events[-1]["quantity_after"] == 4

    # Add Backstock through the management capability, with explicit initials.
    page.evaluate('browseInventory("ALL","Backstock")')
    assert "Shop hose stock" in page.locator("#inventoryResults").inner_text()
    page.evaluate("openAddInventory()")
    page.fill("#addItemName", "New shop hose")
    page.fill("#addQty", "2")
    page.fill("#addCategory", "Cooling")
    page.select_option("#addPlatform", "E92")
    page.select_option("#addLocation", "Backstock")
    assert_no_request(backend, lambda: page.evaluate("addInventoryItem()"))
    page.fill("#addInitials", "ns")
    page.evaluate("addInventoryItem()")
    added = next(item for item in backend.items if item["item_name"] == "New shop hose")
    assert added["stock_category"] == "Backstock" and added["quantity"] == 2
    assert backend.events[-1]["event_type"] == "add_stock" and backend.events[-1]["actor_initials"] == "NS"

    # Every bin creation and cart movement has its own initials field and audit event.
    page.evaluate("openLabelAssistant()")
    page.evaluate("openCreateBin()")
    page.select_option("#binMake", "BMW")
    page.select_option("#binModel", "E92")
    page.select_option("#binSystem", "Cooling")
    page.select_option("#binSubsystem", "Hoses / plumbing")
    page.select_option("#binCartLocation", "A")
    assert_no_request(backend, lambda: page.evaluate("createInventoryBin()"))
    page.fill("#binCreateInitials", "bc")
    page.evaluate("createInventoryBin()")
    created_bin = next(row for row in backend.bins if row["bin_code"].startswith("B-E92-COOL-HOSE"))
    assert backend.events[-1]["event_type"] == "bin_created"
    page.locator("#binManagementControls summary").click()
    page.select_option("#binCartLocationSelect", "B")
    assert_no_request(backend, lambda: page.evaluate("saveBinCartLocation()"))
    page.fill("#binCartInitials", "cm")
    page.evaluate("saveBinCartLocation()")
    assert created_bin["cart_location"] == "B" and backend.events[-1]["event_type"] == "bin_moved"

    # Fast Move follows inventory type -> chassis -> cart -> matching bin, preserving units.
    before_move_quantity = sum(item["quantity"] or 0 for item in backend.items)
    source_before = copy.deepcopy(backend.item("E92-FLAGS"))
    page.evaluate('openAssignPartToBin("","E92-FLAGS")')
    assert page.locator("#assignChassis").is_visible()
    page.select_option("#assignInventoryType", "Mobile")
    page.select_option("#assignChassis", "F30")
    page.select_option("#assignPartCart", "F30-B")
    options = page.locator("#assignBinSelect option").evaluate_all("els=>els.map(e=>e.value)")
    assert uid(240) in options and uid(242) in options and uid(241) not in options, options
    page.select_option("#assignBinSelect", uid(240))
    page.fill("#assignPartQty", "1")
    page.check("#assignPartReorder")
    assert_no_request(backend, lambda: page.evaluate("assignSelectedPartToBin()"))
    page.fill("#assignPartInitials", "mv")
    page.select_option("#assignChassis", "")
    assert_no_request(backend, lambda: page.evaluate("assignSelectedPartToBin()"))
    page.select_option("#assignChassis", "F30")
    page.select_option("#assignPartCart", "F30-B")
    page.select_option("#assignBinSelect", uid(240))
    page.evaluate("assignSelectedPartToBin()")
    moved = next(item for item in backend.items if item["inventory_code"] == "E92-FLAGS-SPLIT")
    assert moved["platform"] == "F30" and moved["inventory_bin_id"] == uid(240) and moved["cart_code"] == "F30-B"
    assert moved["stock_category"] == "Mobile" and moved["quantity_unit"] == "sets" and moved["reorder_flag"] is True
    assert moved["source_metadata"] == source_before["source_metadata"] and moved["tag_id"] is None
    assert sum(item["quantity"] or 0 for item in backend.items) == before_move_quantity
    assert backend.item("E92-FLAGS")["inventory_bin_id"] == source_before["inventory_bin_id"]
    assert [event["event_type"] for event in backend.events[-2:]] == ["move_inventory", "move_inventory"]

    # Count/tag allocation still works, but label printing is not a primary crew task.
    page.evaluate("(code)=>openPartTag(code)", added["inventory_code"])
    assert_no_request(backend, lambda: page.evaluate("preparePartTag()"))
    page.fill("#partTagInitials", "pt")
    page.evaluate("preparePartTag()")
    assert added["tag_id"] and added["quantity"] == 2
    assert page.locator(".part-tag-face").count() == 4
    dimensions = page.locator("#labelPrintCanvas").bounding_box()
    assert dimensions["width"] == 384 and dimensions["height"] == 576
    tag = added["tag_id"]
    before_tag_events = len(backend.events)
    page.evaluate("preparePartTag()")
    assert added["tag_id"] == tag and len(backend.events) == before_tag_events
    page.evaluate("(code)=>openPartTag(code)", added["inventory_code"])
    page.check("#partTagAdjustCount")
    page.fill("#partTagNewQty", "3")
    assert_no_request(backend, lambda: page.evaluate("preparePartTag()"))
    page.fill("#partTagInitials", "qc")
    page.evaluate("preparePartTag()")
    assert added["quantity"] == 3 and added["tag_id"] == tag
    assert backend.events[-1]["event_type"] == "quantity_corrected" and backend.events[-1]["actor_initials"] == "QC"

    # Registered bins, loose containers on both carts, and UUID-only contents remain intact.
    page.evaluate('browseInventory("F30")')
    page.select_option("#inventoryCartSelect", "F30-B")
    page.evaluate("openChassisBins()")
    assert page.input_value("#binChassisFilter") == "F30" and page.input_value("#binCartFilter") == "ALL"
    assert "F30-000" in page.locator("#binResults").inner_text()
    page.evaluate('openBinDetail("F30-000")')
    assert "Loose rotor A" in page.locator("#binContents").inner_text() and "Loose rotor B" in page.locator("#binContents").inner_text()
    page.evaluate('openBinDetail("E92-008")')
    assert "Seal set" not in page.locator("#binContents").inner_text()
    page.evaluate('openBinDetail("E92-018")')
    assert "E92-018-A" in page.locator("#binDetailWrap").inner_text() and "E92-018-B" in page.locator("#binDetailWrap").inner_text()
    assert_handlers(page)

    # Inventory Activity is reachable under management and renders the shared read-only ledger.
    before_history_writes = len(backend.attempts)
    page.evaluate('showScreen("inventoryManagement")')
    page.locator('#inventoryManagement [onclick="openInventoryEventHistory()"] ').click()
    page.wait_for_selector("#inventoryEventHistory.active")
    page.wait_for_function("document.getElementById('inventoryEventList').textContent.includes('use part')")
    history = page.locator("#inventoryEventList").inner_text()
    assert page.locator("#inventoryEventList .card").count() == len(backend.events)
    for context in ["E92-KNOWN", "E92-008", "E92-A", "JD", "Uncounted", "quantity corrected", "move inventory", "bin moved"]:
        assert context in history, (context, history)
    assert len(backend.attempts) == before_history_writes
    assert_handlers(page)

    # All inventory mutation requests carry explicit normalized initials. The UI never writes ledger rows.
    assert backend.attempts and all(request["headers"].get("x-otr-initials", "").strip() for request in backend.attempts)
    assert not any(request["path"] == "inventory_events" for request in backend.attempts)
    assert all(event["actor_initials"] and event["actor_initials"] == event["actor_initials"].upper() for event in backend.events)
    assert all(event["from_state"] is not None or event["event_type"] in ["add_stock", "bin_created", "move_inventory"] for event in backend.events)

    # Feedback, reports, operational forms and device-local queue are unchanged.
    page.evaluate('activeCategory="Mechanical / Cars";document.getElementById("quickText").value="Smoke test";submitQuick()')
    assert backend.submissions[-1]["submission_type"] == "feedback_quick"
    page.evaluate('answers={test:"Detailed smoke test"};submitDetailed()')
    assert backend.submissions[-1]["submission_type"] == "feedback_detailed"
    page.evaluate('document.getElementById("peEvent").value="Test event";document.getElementById("peRole").selectedIndex=1;document.getElementById("pe4").value="Worked well";submitPostEvent()')
    assert backend.submissions[-1]["submission_type"] == "post_event_report"
    page.evaluate("loadAdminSubmissions()")
    assert "Test event" in page.locator("#adminSubmissionsList").inner_text()
    backend.offline_submissions = True
    page.evaluate('document.getElementById("quickText").value="Offline smoke test";submitQuick()')
    assert page.evaluate("getStore().length") == 1
    page.evaluate('showScreen("admin")')
    assert "Offline smoke test" in page.locator("#admin").inner_text()
    backend.offline_submissions = False
    page.evaluate("syncQueue()")
    assert page.evaluate("getStore().length") == 0
    for key in page.evaluate("Object.keys(operationalFormDefinitions)"):
        page.evaluate("(key)=>openOperationalForm(key)", key)
        assert_handlers(page)

    # Fresh document avoids rapid synthetic history resets contaminating the real click/back path.
    page.goto(base_url)
    page.wait_for_function("vehicleRegistryReady")
    assert page.locator("#home .grid button").first.get_attribute("id") == "homeInventoryButton"
    page.locator("#homeInventoryButton").click()
    page.wait_for_selector("#inventoryHome.active")
    page.locator("#inventoryHome .back").click()
    page.wait_for_selector("#home.active")
    page.locator("#homeInventoryButton").click()
    page.locator("#crewMobileSearchButton").click()
    page.wait_for_selector("#inventoryBrowse.active")
    page.screenshot(path=str(OUTPUT / "crew-mobile-search.png"), full_page=True)
    assert_handlers(page)
    screens = page.locator(".screen").evaluate_all("els=>els.map(e=>e.id)")
    page.evaluate("resetAndHome()")
    page.wait_for_function("portalHistoryDepth===0 && pendingPortalResetScreen===null")
    for screen in screens:
        page.evaluate("id=>showScreen(id,{historyMode:'none'})", screen)
        if screen != "home":
            page.locator("#globalHomeButton").click()
        page.wait_for_selector("#home.active")
    return dict(result="PASS", screens_with_home_navigation=len(screens), crew_search_first="PASS", combined_location_bin="PASS", exact_vehicle_selection="PASS",
                known_null_and_zero_use="PASS", explicit_initials_all_paths="PASS", use_retry_idempotency="PASS",
                pending_use_navigation="PASS", read_only_activity_history="PASS",
                management_and_fast_move="PASS", ledger_events=len(backend.events), successful_inventory_requests=len(backend.writes),
                submissions_and_offline_queue="PASS", exact_bin_contents="PASS", existing_4x6_canvas="PASS")


backend = Backend()
server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base_url = f"http://127.0.0.1:{server.server_address[1]}"
runtime_errors = []
alerts = []
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1280, "height": 1000})
        page.set_default_timeout(15000)
        page.route("**/rest/v1/**", backend.route)
        page.on("pageerror", lambda error: runtime_errors.append(str(error)))
        page.on("dialog", lambda dialog: (alerts.append(dialog.message), dialog.accept()))
        result = run_checks(page, backend)
        assert not runtime_errors, runtime_errors
        assert not backend.errors, backend.errors
        result.update(runtime_errors=runtime_errors, backend_errors=backend.errors, artifacts=str(OUTPUT))
        print(json.dumps(result, indent=2))
        browser.close()
finally:
    server.shutdown()
    server.server_close()
