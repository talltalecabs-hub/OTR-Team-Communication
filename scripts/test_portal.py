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
    make_bin(202, "E92-002", "E92", "Front suspension", "A"),
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
    make_item(249, "E92-002-L249", "Center control arm bushing", quantity=None, bin_id=uid(202)),
]
INITIAL_ITEMS[0].update(part_number="CTS-42", condition="Serviceable", notes="Pit lane spare")
INITIAL_ITEMS[0]["source_metadata"]["label_text"] = "GLANDLABELTOKEN imported sensor label"
INITIAL_ITEMS[1].update(category="Fasteners", condition="Used", notes="Assorted clips")
INITIAL_ITEMS[-1].update(
    notes="Prior crew note", tag_id="TAG-E92-002-L249-C599823B", part_number="BUSH-249-REF",
    category="Suspension", source="OTR_Master_Inventory_F22_E92_Rear_Suspension_Update_2026-11-14.xlsx")
INITIAL_ITEMS[-1]["source_metadata"].update(
    source_row=249, label_text="CENTER CONTROL ARM BUSHING", photo_filename="IMG_LINEAGE_249.jpeg")
# Misleading text must never make a part appear in the wrong bin's contents.
INITIAL_ITEMS[3]["location"] = "E92-008"


class FixtureError(Exception):
    pass


class Backend:
    def __init__(self):
        self.intake_requests = {}
        self.drafts = {}
        self.photos = {}
        self.draft_attempts = []
        self.lose_next_draft_create = False
        self.lose_next_draft_commit = False
        self.vehicles = [dict(copy.deepcopy(v),is_active=True,revision=1) for v in REGISTRY]
        self.vehicle_attempts = []
        self.vehicle_events = []
        self.items = copy.deepcopy(INITIAL_ITEMS)
        self.bins = copy.deepcopy(INITIAL_BINS)
        self.events = []
        self.submissions = []
        self.attempts = []
        self.writes = []
        self.errors = []
        self.use_requests = {}
        self.offline_submissions = False
        self.lose_next_bin_response = False
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

    def save_vehicle(self, data, actor):
        code, revision, changes = data["p_vehicle_code"], data["p_revision"], data["p_changes"]
        vehicle = next((v for v in self.vehicles if v["vehicle_code"] == code), None)
        if vehicle and revision == 0:
            return vehicle
        if vehicle and vehicle["revision"] != revision:
            raise FixtureError("This vehicle changed since you opened it. Reload before saving.")
        before = copy.deepcopy(vehicle)
        if vehicle is None:
            vehicle = dict(vehicle_code=code, revision=0, is_active=True)
        for key in ["vehicle_name", "platform", "status"]:
            if not str(changes.get(key, vehicle.get(key, ""))).strip():
                raise FixtureError("Enter a vehicle name, chassis and status")
        vehicle.update(copy.deepcopy(changes))
        vehicle["vehicle_name"] = vehicle["vehicle_name"].strip()
        vehicle["designation"] = vehicle.get("designation") or None
        vehicle["revision"] += 1
        if before is None:
            self.vehicles.append(vehicle)
        self.vehicle_events.append(dict(actor_initials=actor, from_state=before, to_state=copy.deepcopy(vehicle)))
        return vehicle

    def intake_route(self,route):
        request=route.request
        if request.method=='OPTIONS':
            route.fulfill(status=204,headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST'});return
        data=request.post_data_json;path=urlsplit(request.url).path.rsplit('/',1)[-1]
        self.attempts.append(dict(path='rpc/'+path,method='POST',data=copy.deepcopy(data),headers=dict(request.headers)))
        actor=self.actor(request,data);request_id=data['p_request_id']
        if request_id in self.intake_requests:result=self.intake_requests[request_id]
        elif path=='create_inventory_stock':
            result=dict(copy.deepcopy(data['p_item']),id=request_id,quantity_unit='pcs')
            self.items.append(result);self.event('add_stock',actor,None,result,delta=result['quantity'])
        elif path=='rename_inventory_part':
            result=self.find_item(data['p_item_id']);before=copy.deepcopy(result);result['item_name']=data['p_name'];self.event('metadata_changed',actor,before,result)
        elif path=='rename_inventory_bin':
            result=next(row for row in self.bins if row['id']==data['p_bin_id'])
            before=copy.deepcopy(result);result['name']=data['p_name'];self.event('bin_updated',actor,before,result)
        elif path=='reconcile_inventory_stock':
            result=self.find_item(data['p_item_id'])
            if result['quantity']!=data['p_expected_quantity']:
                route.fulfill(status=409,content_type='application/json',body=json.dumps({'code':'40001','message':'The stock count changed. Refresh matches.'}));return
            before=copy.deepcopy(result)
            result['quantity']=result['quantity']+data['p_quantity'] if data['p_mode']=='add' else data['p_quantity']
            self.event('quantity_corrected',actor,before,result,delta=result['quantity']-(before['quantity'] or 0))
        else:
            ids=data['p_expected_bin_ids'];moved=[]
            for item in self.items:
                if item['inventory_bin_id'] not in ids:continue
                before=copy.deepcopy(item);item.update(inventory_bin_id=data['p_target_bin_id'],cart_code=None,stock_category='Backstock' if data['p_destination']=='backstock' else 'Mobile',location='Backstock' if data['p_destination']=='backstock' else next(b['bin_code'] for b in self.bins if b['id']==data['p_target_bin_id']))
                self.event('move_inventory',actor,before,item,delta=0);moved.append(item['id'])
            for physical in self.bins:
                if physical['id'] in ids:physical['status']='Archived'
            result=dict(item_count=len(moved),bin_count=len(ids))
        self.intake_requests[request_id]=copy.deepcopy(result);self.writes.append(self.attempts[-1])
        route.fulfill(status=200,content_type='application/json',body=json.dumps(result),headers={'access-control-allow-origin':'*'})

    def workspace_route(self, route):
        request=route.request
        parsed=urlsplit(request.url)
        if request.method=='OPTIONS':
            route.fulfill(status=204,headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST'})
            return
        def reply(data,status=200):
            route.fulfill(status=status,content_type='application/json',body=json.dumps(data),headers={'access-control-allow-origin':'*'})
        if '/storage/v1/' in parsed.path:
            path=parsed.path.split('otr-inventory-workspace/',1)[-1]
            if '/sign/' in parsed.path and request.method=='POST':
                return reply({'signedURL':'/object/sign/otr-inventory-workspace/'+path+'?token=fixture'})
            if request.method=='POST':
                assert request.headers.get('x-upsert')=='false'
                assert request.headers.get('cache-control')=='no-store'
                self.photos[path]=request.post_data_buffer
                return reply({'Key':path})
            if path in self.photos:
                return route.fulfill(status=200,content_type='image/png',body=self.photos[path])
            return reply({'message':'Missing photo'},404)
        if request.method=='GET':
            rows=list(self.drafts.values())
            if 'state=neq.archived' in request.url: rows=[r for r in rows if r['state']!='archived']
            return reply(rows)
        data=request.post_data_json
        self.draft_attempts.append(copy.deepcopy(data))
        try:
            actor=self.actor(request,data)
            path=parsed.path.rsplit('/',1)[-1]
            if path=='save_inventory_workspace_draft':
                card=self.drafts.get(data['p_id'])
                if not card:
                    assert data['p_revision']==0
                    changes=data['p_changes']
                    card=dict(id=data['p_id'],tag_id='TAG-D-'+data['p_id'].replace('-','').upper(),revision=1,state='draft',inventory_item_id=None,data=copy.deepcopy(changes.get('data',{})),x=changes.get('x',1200),y=changes.get('y',1200),actor_initials=actor,created_by=actor)
                    self.drafts[card['id']]=card
                    if self.lose_next_draft_create:
                        self.lose_next_draft_create=False;route.abort('connectionreset');return
                elif data['p_revision']!=0:
                    if data['p_revision']!=card['revision']: return reply({'code':'40001','message':'This card changed on another device. Reload it before saving.'},409)
                    changes=copy.deepcopy(data['p_changes'])
                    card['data'].update(changes.pop('data',{}));card.update(changes);card['revision']+=1;card['actor_initials']=actor
            elif path=='duplicate_inventory_workspace_draft':
                card=self.drafts.get(data['p_new_id'])
                if not card:
                    source=self.drafts[data['p_source_id']]
                    card=copy.deepcopy(source)
                    card.update(id=data['p_new_id'],tag_id='TAG-D-'+data['p_new_id'].replace('-','').upper(),state='draft',inventory_item_id=None,revision=1,x=source['x']+36,y=source['y']+36,source_draft_id=source['id'],actor_initials=actor)
                    self.drafts[card['id']]=card
            elif path=='commit_inventory_workspace_draft':
                card=self.drafts[data['p_id']]
                if card['state']!='committed':
                    assert card['revision']==data['p_revision'] and card['data'].get('item_name')
                    details=card['data']
                    item=make_item(self.next_number+1,'WS-'+card['id'].replace('-','').upper(),details['item_name'],platform=details.get('platform') or 'Unassigned',quantity=details.get('quantity'))
                    item.update(id=card['id'],tag_id=card['tag_id'],compatibility=list(set([details.get('platform')]+details.get('compatibility',[]))),source_metadata={'workspace_draft_id':card['id'],'photo_paths':details.get('photo_paths',[])})
                    if data.get('p_mode','separate')!='separate':
                        item=self.find_item(data['p_existing_item_id']);before=copy.deepcopy(item)
                        item['quantity']=item['quantity']+details['quantity'] if data['p_mode']=='add' else details['quantity']
                        self.event('quantity_corrected',actor,before,item,delta=item['quantity']-before['quantity'])
                    else:self.items.append(item);self.event('add_stock',actor,None,item,delta=item.get('quantity'))
                    card.update(state='committed',inventory_item_id=item['id'],revision=card['revision']+1)
                    if self.lose_next_draft_commit:
                        self.lose_next_draft_commit=False;route.abort('connectionreset');return
            else: raise FixtureError('Unknown workspace endpoint')
            reply(card)
        except Exception as error:
            self.errors.append(repr(error));reply({'message':str(error)},400)

    def route(self, route):
        request = route.request
        if any('/rpc/'+name in request.url for name in ['create_inventory_stock','reconcile_inventory_stock','retire_inventory_bin','rename_inventory_bin','rename_inventory_part']):
            return self.intake_route(route)
        if '/inventory_workspace_drafts' in request.url or '_inventory_workspace_draft' in request.url or '/storage/v1/' in request.url:
            return self.workspace_route(route)
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
        registry_mutation = request.method == "POST" and path == "rpc/save_vehicle_registry"
        inventory_mutation = request.method != "GET" and not registry_mutation and (path.startswith("inventory_") or path.startswith("rpc/"))
        try:
            actor = None
            if inventory_mutation:
                self.attempts.append(dict(path=path, method=request.method, data=copy.deepcopy(data), headers=dict(request.headers)))
                actor = self.actor(request, data)
            if registry_mutation:
                self.vehicle_attempts.append(copy.deepcopy(data))
                actor = self.actor(request,data)
            if path == "vehicles" and request.method == "GET":
                result = self.vehicles
            elif path == "rpc/save_vehicle_registry" and request.method == "POST":
                result = self.save_vehicle(data,actor)
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
                    physical_bin = dict(copy.deepcopy(data), id=data.get("id") or self.new_id())
                    self.bins.append(physical_bin)
                    self.event("bin_created", actor, None, physical_bin)
                    result = [physical_bin]
                    if self.lose_next_bin_response:
                        self.lose_next_bin_response=False
                        self.writes.append(self.attempts[-1])
                        route.abort("connectionreset")
                        return
                elif request.method == "PATCH":
                    bin_id = query.get("id", [""])[0].removeprefix("eq.")
                    physical_bin = next(row for row in self.bins if row["id"] == bin_id)
                    before = copy.deepcopy(physical_bin)
                    physical_bin.update(copy.deepcopy(data))
                    self.event("bin_moved", actor, before, physical_bin)
                    parents=[physical_bin]
                    while parents:
                        parent=parents.pop()
                        for child in self.bins:
                            if child.get('parent_bin_id')==parent['id'] and child.get('status')!='Archived':
                                old_child=copy.deepcopy(child);child['cart_location']=parent.get('cart_location');self.event('bin_moved',actor,old_child,child);parents.append(child)
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


def assert_label_pdf(page, filename, width, height):
    pdf = page.pdf(path=str(OUTPUT / filename), prefer_css_page_size=True, print_background=True)
    assert len(re.findall(rb"/Type\s*/Page\b", pdf)) == 1, filename
    boxes = re.findall(rb"/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]", pdf)
    assert boxes and all(abs(float(w) - width) <= .6 and abs(float(h) - height) <= .6 for w, h in boxes), (filename, boxes)


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
    assert "Use Part" in page.locator("#inventoryDetail .actions").first.inner_text()
    assert "Verify / Correct" not in page.locator("#inventoryDetail .actions").first.inner_text()
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

    # The open-bin search only filters direct contents and keeps every row full width.
    page.evaluate('openBinDetail("E92-008")')
    assert page.locator("#binContentsSearch").is_visible()
    assert page.input_value("#binContentsSearch") == ""
    assert page.locator("#binContents").evaluate("el=>el.classList.contains('bin-contents-list')")
    assert page.locator("#binContents .inventory-card").count() == 3
    direct_count = page.locator("#binDetailWrap .inventory-field").filter(has=page.locator('.k', has_text="Direct contents")).inner_text()
    assert "3 records" in direct_count, direct_count
    for query in ["coolant temperature", "CTS-42", "E92-KNOWN", "Serviceable", "Pit lane spare", "GLANDLABELTOKEN"]:
        page.fill("#binContentsSearch", query)
        assert page.locator("#binContents .inventory-card").count() == 1, query
        assert "Coolant temperature sensor" in page.locator("#binContents").inner_text(), query
        assert "3 records" in page.locator("#binDetailWrap .inventory-field").filter(has=page.locator('.k', has_text="Direct contents")).inner_text()
    page.fill("#binContentsSearch", "Fasteners")
    assert page.locator("#binContents .inventory-card").count() == 1
    assert "Uncounted hardware" in page.locator("#binContents").inner_text()
    for query in ["Seal set", "Center control arm bushing", "definitely absent"]:
        page.fill("#binContentsSearch", query)
        assert page.locator("#binContents .inventory-card").count() == 0, query
        assert "no match" in page.locator("#binContents").inner_text().lower(), query
    page.fill("#binContentsSearch", "")
    cards = page.locator("#binContents .inventory-card")
    assert cards.count() == 3
    boxes = [card.bounding_box() for card in cards.all()]
    contents_box = page.locator("#binContents").bounding_box()
    assert all(abs(box["x"] - contents_box["x"]) <= 1 and abs(box["width"] - contents_box["width"]) <= 1 for box in boxes), boxes
    assert all(boxes[index]["y"] >= boxes[index-1]["y"] + boxes[index-1]["height"] for index in range(1, len(boxes))), boxes
    page.fill("#binContentsSearch", "CTS-42")
    page.locator("#binContents .inventory-card").click()
    page.wait_for_selector("#inventoryDetail.active")
    assert page.evaluate("currentInventoryItem.inventory_code") == "E92-KNOWN"
    page.evaluate('openBinDetail("E92-002")')
    assert page.input_value("#binContentsSearch") == ""
    assert page.locator("#binContents .inventory-card").count() == 1
    assert "Center control arm bushing" in page.locator("#binContents").inner_text()

    # Crew notes and the distinct Not Found action are editable directly on part detail.
    open_item(page, "E92-002-L249")
    assert page.locator("#inventoryDetailNotes").is_visible()
    assert page.input_value("#inventoryDetailNotes") == "Prior crew note"
    assert page.locator("#inventoryDetailInitials").is_visible()
    assert page.input_value("#inventoryDetailInitials") == ""
    not_found = page.locator("#inventoryDetailNotFound")
    assert not_found.is_visible() and "Not Found" in not_found.inner_text()
    assert "danger" in not_found.get_attribute("class").split()
    lineage_before = copy.deepcopy(backend.item("E92-002-L249"))
    page.fill("#inventoryDetailNotes", "Crew note: check this bushing before Friday.")
    assert_no_request(backend, lambda: page.locator("#inventoryDetailSaveNotes").click())
    page.fill("#inventoryDetailInitials", " nt ")
    with page.expect_response("**/inventory_items?id=eq.*"):
        page.locator("#inventoryDetailSaveNotes").click()
    page.wait_for_function("!document.getElementById('inventoryDetailSaveNotes').disabled")
    lineage = backend.item("E92-002-L249")
    assert lineage["notes"] == "Crew note: check this bushing before Friday."
    note_event = backend.events[-1]
    assert note_event["event_type"] == "metadata_changed" and note_event["actor_initials"] == "NT"
    assert note_event["from_state"]["notes"] == "Prior crew note" and note_event["to_state"]["notes"] == lineage["notes"]
    for key, value in lineage_before.items():
        if key not in ["notes", "updated_at"]:
            assert lineage[key] == value, key
    assert page.input_value("#inventoryDetailInitials") == ""
    page.fill("#inventoryDetailNotes", "Unsaved draft remains while marking Not Found.")
    assert_no_request(backend, lambda: not_found.click())
    page.fill("#inventoryDetailInitials", "nf")
    with page.expect_response("**/inventory_items?id=eq.*"):
        not_found.click()
    page.wait_for_function("document.getElementById('inventoryDetailNoteStatus').textContent==='Marked Not Found.'")
    assert page.input_value("#inventoryDetailNotes") == "Unsaved draft remains while marking Not Found."
    assert lineage["notes"] == "Crew note: check this bushing before Friday."
    assert lineage["verification_status"] == "Not Found" and lineage["status"] == "Missing"
    assert lineage["quantity"] is None and lineage["source_metadata"] == lineage_before["source_metadata"]
    assert backend.events[-1]["event_type"] == "verification_changed" and backend.events[-1]["actor_initials"] == "NF"
    assert_handlers(page)

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
    page.evaluate("openLegacyAddInventory()")
    page.fill("#addItemName", "New shop hose")
    page.fill("#addQty", "2")
    page.fill("#addCategory", "Cooling")
    page.select_option("#addPlatform", "F30")
    page.locator('#addCompatibleChassis input[value="F22"]').check()
    page.select_option("#addLocation", "Backstock")
    assert_no_request(backend, lambda: page.evaluate("addInventoryItem()"))
    page.fill("#addInitials", "ns")
    page.evaluate("addInventoryItem()")
    added = next(item for item in backend.items if item["item_name"] == "New shop hose")
    assert added["stock_category"] == "Backstock" and added["quantity"] == 2
    assert backend.events[-1]["event_type"] == "add_stock" and backend.events[-1]["actor_initials"] == "NS"
    assert set(added["compatibility"])=={"F22","F30"}
    shared_identity=added["id"]
    writes_before_search=len(backend.writes)
    for chassis in ["F22","F30","M235 / M235iR"]:
        page.evaluate("(chassis)=>browseInventory(chassis,'Backstock')",chassis)
        assert "New shop hose" in page.locator("#inventoryResults").inner_text()
        matching=page.evaluate("inventoryData.filter(i=>i.item_name==='New shop hose').map(i=>({id:i.id,quantity:i.quantity}))")
        assert matching==[{"id":shared_identity,"quantity":2}]
    assert len(backend.writes)==writes_before_search
    page.evaluate("(key)=>openInventoryDetail(key,'none',true)",added["inventory_code"])

    before_another = len(backend.writes)
    page.locator("#addAnotherPartButton").click()
    page.wait_for_selector("#inventoryAdd.active")
    assert page.input_value("#addItemName") == page.input_value("#addPartNumber") == page.input_value("#addNotes") == page.input_value("#addInitials") == ""
    assert page.input_value("#addQty") == "1"
    assert page.locator("#addItemName").evaluate("el=>el===document.activeElement")
    assert len(backend.writes) == before_another


    # Every bin creation and cart movement has its own initials field and audit event.
    page.evaluate("openLabelAssistant()")
    page.evaluate("openCreateBin()")
    page.select_option("#binMake", "BMW")
    page.select_option("#binModel", "E92")
    assert page.input_value("#binCodePreview")=="E92-023"
    page.select_option("#binSystem", "Cooling")
    page.select_option("#binSubsystem", "Hoses / plumbing")
    page.select_option("#binCartLocation", "A")
    assert_no_request(backend, lambda: page.evaluate("createInventoryBin()"))
    page.fill("#binCreateInitials", "bc")
    page.evaluate("createInventoryBin()")
    created_bin = next(row for row in backend.bins if row["bin_code"] == "E92-023")
    assert backend.events[-1]["event_type"] == "bin_created"
    page.locator("#binManagementControls summary").click()
    page.select_option("#binCartLocationSelect", "B")
    assert_no_request(backend, lambda: page.evaluate("saveBinCartLocation()"))
    page.fill("#binCartInitials", "cm")
    page.evaluate("saveBinCartLocation()")
    assert created_bin["cart_location"] == "B" and backend.events[-1]["event_type"] == "bin_moved"
    # Manual IDs retain the chassis format; classification does not rewrite them.
    page.evaluate("openCreateBin()")
    page.select_option("#binMake","BMW")
    page.select_option("#binModel","E92")
    assert page.input_value("#binCodePreview")=="E92-024"
    page.fill("#binCodePreview","e92-30")
    page.select_option("#binSystem","Miscellaneous")
    assert page.input_value("#binCodePreview")=="E92-30"
    page.fill("#binCreateInitials","bn")
    page.evaluate("createInventoryBin()")
    assert next(row for row in backend.bins if row["bin_code"]=="E92-030")["qr_value"]=="OTR:BIN:E92-030"
    page.evaluate("openCreateBin()")
    page.select_option("#binMake","BMW")
    page.select_option("#binModel","E92")
    page.select_option("#binSystem","Miscellaneous")
    page.fill("#binCodePreview","E92-023")
    page.fill("#binCreateInitials","bn")
    assert_no_request(backend,lambda:page.evaluate("createInventoryBin()"))
    page.fill("#binCodePreview","F30-050")
    assert_no_request(backend,lambda:page.evaluate("createInventoryBin()"))
    page.evaluate("useNextBinCode()")
    assert page.input_value("#binCodePreview")=="E92-031"
    page.evaluate("createInventoryBin()")
    assert any(row["bin_code"]=="E92-031" for row in backend.bins)
    assert page.evaluate("nextBinCode('F22')")=="F22-002"
    assert page.evaluate("nextBinCode('F30')")=="F30-003"
    assert page.evaluate("nextBinCode('986')")=="986-001"
    # A completed save with a lost response reopens the same stable bin on retry.
    page.evaluate("openCreateBin()")
    page.select_option("#binMake","BMW")
    page.select_option("#binModel","E92")
    page.select_option("#binSystem","Miscellaneous")
    page.fill("#binCreateInitials","bn")
    before_bins=len(backend.bins)
    backend.lose_next_bin_response=True
    page.evaluate("createInventoryBin()")
    assert len(backend.bins)==before_bins+1
    attempts=len(backend.attempts)
    page.evaluate("createInventoryBin()")
    assert len(backend.bins)==before_bins+1 and len(backend.attempts)==attempts
    assert "E92-032" in page.locator("#binDetailWrap").inner_text()


    # Sharing an existing part changes compatibility only, never stock or placement.
    open_item(page,"F30-LOOSE-A")
    shared_before=copy.deepcopy(backend.item("F30-LOOSE-A"))
    page.fill("#inventoryDetailNotes","Unsaved note remains")
    page.locator('#detailCompatibleChassis input[value="F22"]').check()
    assert_no_request(backend,lambda:page.evaluate("saveInventoryCompatibility()"))
    page.fill("#inventoryDetailInitials","sh")
    page.evaluate("saveInventoryCompatibility()")
    shared=backend.item("F30-LOOSE-A")
    assert set(shared["compatibility"])=={"F22","F30"}
    for key,value in shared_before.items():
        if key not in ["compatibility","updated_at"]:assert shared[key]==value,key
    assert page.input_value("#inventoryDetailNotes")=="Unsaved note remains"
    assert backend.events[-1]["event_type"]=="metadata_changed"
    page.evaluate('browseInventory("F22")')
    assert "Loose rotor A" in page.locator("#inventoryResults").inner_text()
    open_use(page,"F30-LOOSE-A")
    compatible_options=page.locator("#usePartVehicle option").evaluate_all("els=>els.map(e=>e.value)")
    assert "F30-GOLDIE" in compatible_options and "M235-RAPTOR" in compatible_options


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
    assert page.locator("#labelPrintCanvas .part-tag-face").count() == 1
    assert page.locator("#labelPrintCanvas .part-fold-sheet, #labelPrintCanvas .rotate").count() == 0
    dimensions = page.locator("#labelPrintCanvas").bounding_box()
    assert abs(dimensions["width"] - 50*96/25.4) < .5 and abs(dimensions["height"] - 25*96/25.4) < .5
    face = page.locator("#labelPrintCanvas .part-tag-face")
    human_text = face.inner_text()
    assert human_text and human_text == human_text.upper(), human_text
    assert face.locator(".part-tag-qr svg").count() == 1
    assert face.locator(".part-tag-qr").get_attribute("data-scan-value")==added["tag_id"]
    assert face.get_attribute("data-tag-id") == added["tag_id"]
    assert "25×50 mm" in page.locator("#labelPrintButton").inner_text()
    assert_label_pdf(page, "part-label-50x25mm.pdf", 50*72/25.4, 25*72/25.4)
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

    # Tiny labels keep unknown counts unknown and preserve workbook row lineage and stable tag identity.
    lineage_before_label = copy.deepcopy(backend.item("E92-002-L249"))
    page.evaluate('openPartTag("E92-002-L249")')
    assert page.input_value("#partTagInitials") == ""
    assert_no_request(backend, lambda: page.evaluate("preparePartTag()"))
    lineage_face = page.locator("#labelPrintCanvas .part-tag-face")
    assert lineage_face.count() == 1
    assert lineage_face.get_attribute("data-tag-id") == "TAG-E92-002-L249-C599823B"
    human_text = lineage_face.inner_text()
    assert human_text == human_text.upper() and "CENTER CONTROL ARM BUSHING" in human_text
    assert "E92-A" in human_text and "E92-002" in human_text
    assert "UNCOUNTED" in human_text and not re.search(r"QTY\s+0(?:\D|$)", human_text), human_text
    assert "L249" not in human_text and "IMG_LINEAGE" not in human_text and ".XLSX" not in human_text, human_text
    assert lineage_face.locator(".part-tag-qr").get_attribute("data-scan-value")=="TAG-E92-002-L249-C599823B"
    page.locator("#labelPrintCanvas").screenshot(path=str(OUTPUT/"part-label-small.png"))
    assert backend.item("E92-002-L249") == lineage_before_label
    assert backend.item("E92-002-L249")["source_metadata"]["source_row"] == 249
    assert_label_pdf(page, "lineage-part-label-50x25mm.pdf", 50*72/25.4, 25*72/25.4)
    page.evaluate('openBinLabel("E92-002")')
    assert page.locator("#labelPrintCanvas .bin-label-sheet").count() == 1
    assert page.locator("#labelPrintCanvas .part-tag-face").count() == 0
    assert "4×6" in page.locator("#labelPrintButton").inner_text()
    dimensions = page.locator("#labelPrintCanvas").bounding_box()
    assert dimensions["width"] == 384 and dimensions["height"] == 576
    assert_label_pdf(page, "bin-label-4x6.pdf", 288, 432)
    options=page.locator("#labelMediaSelect option").evaluate_all("els=>els.map(e=>e.value)")
    assert options == ["inch4x6", "metric25x50", "metric150x100"]
    for media, width, height in [("metric25x50",50*72/25.4,25*72/25.4),("metric150x100",150*72/25.4,100*72/25.4)]:
        before_media_events=len(backend.events)
        page.select_option("#labelMediaSelect",media)
        assert_label_pdf(page,f"bin-label-{media}.pdf",width,height)
        assert len(backend.events)==before_media_events
    page.select_option("#labelMediaSelect","inch4x6")
    page.evaluate('openPartTag("E92-002-L249")')
    page.evaluate("preparePartTag()")
    for media, width, height in [("inch4x6",288,432),("metric150x100",150*72/25.4,100*72/25.4)]:
        page.select_option("#labelMediaSelect",media)
        assert page.locator("#labelPrintCanvas .part-tag-face").count()==1
        assert page.locator(".part-tag-face").get_attribute("data-tag-id")=="TAG-E92-002-L249-C599823B"
        assert_label_pdf(page,f"part-label-{media}.pdf",width,height)
    page.select_option("#labelMediaSelect","metric25x50")


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

    # Administrative vehicle changes are shared and preserve stable history keys.
    page.evaluate("openAdminAssistant()")
    page.get_by_role("button",name=re.compile("^Vehicle Registry")).click()
    page.wait_for_selector("#adminVehicles.active")
    page.wait_for_function("vehicleAdminReady")
    page.fill("#vehicleAdminSearch","Phoenix")
    assert "#69x" in page.locator("#vehicleAdminList").inner_text()
    assert "Hulk" not in page.locator("#vehicleAdminList").inner_text()
    page.locator("#vehicleAdminList .inventory-card").click()
    assert page.input_value("#vehicleAdminName") == "Phoenix"
    assert page.input_value("#vehicleAdminDesignation") == "69x"
    assert page.evaluate("vehicleAdminCurrent.vehicle_code") == "E92-HULK"
    page.evaluate("openVehicleAdmin()")
    page.locator("#vehicleAdminNew").click()
    page.fill("#vehicleAdminName","Registry browser test")
    page.fill("#vehicleAdminDesignation","#77x")
    attempts=len(backend.vehicle_attempts)
    page.evaluate("saveVehicleAdmin()")
    assert len(backend.vehicle_attempts)==attempts
    page.fill("#vehicleAdminInitials"," ab ")
    page.evaluate("saveVehicleAdmin()")
    new_vehicle=next(v for v in backend.vehicles if v["vehicle_name"]=="Registry browser test")
    assert new_vehicle["designation"]=="77x" and new_vehicle["revision"]==1
    assert backend.vehicle_events[-1]["actor_initials"]=="AB"
    assert page.input_value("#vehicleAdminInitials")==""
    attempts=len(backend.vehicle_attempts)
    page.evaluate("toggleVehicleAdmin()")
    assert len(backend.vehicle_attempts)==attempts
    page.fill("#vehicleAdminInitials","rm")
    page.evaluate("toggleVehicleAdmin()")
    assert new_vehicle["is_active"] is False
    assert page.evaluate("(code)=>vehicleOptionsForCategory('E92').some(v=>v.vehicle_code===code)",new_vehicle["vehicle_code"]) is False
    open_use(page,"E92-FLAGS")
    assert new_vehicle["vehicle_code"] not in page.locator("#usePartVehicle option").evaluate_all("els=>els.map(e=>e.value)")
    page.evaluate("openVehicleAdmin()")
    page.evaluate("(code)=>editVehicleAdmin(code)",new_vehicle["vehicle_code"])
    page.fill("#vehicleAdminInitials","rs")
    page.evaluate("toggleVehicleAdmin()")
    assert new_vehicle["is_active"] is True
    assert page.evaluate("(code)=>vehicleOptionsForCategory('E92').some(v=>v.vehicle_code===code)",new_vehicle["vehicle_code"])
    page.fill("#vehicleAdminName","Renamed registry vehicle")
    page.fill("#vehicleAdminInitials","ed")
    page.evaluate("saveVehicleAdmin()")
    assert new_vehicle["vehicle_name"]=="Renamed registry vehicle"
    page.screenshot(path=str(OUTPUT / "vehicle-admin-editor.png"),full_page=True)
    page.fill("#vehicleAdminInitials","rm")
    page.evaluate("toggleVehicleAdmin()")
    assert new_vehicle["is_active"] is False and len(backend.vehicle_events)==5

    workspace_checks(page,backend)

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
    return dict(result="PASS", shared_creation_workspace="PASS", duplicate_stock_choices="PASS", bin_retirement="PASS", bin_and_part_names="PASS", sub_bins_follow_parent="PASS", vehicle_administration="PASS", chassis_bin_sequence="PASS", shared_chassis_compatibility="PASS", screens_with_home_navigation=len(screens), crew_search_first="PASS", combined_location_bin="PASS", exact_vehicle_selection="PASS",
                known_null_and_zero_use="PASS", explicit_initials_all_paths="PASS", use_retry_idempotency="PASS",
                pending_use_navigation="PASS", read_only_activity_history="PASS",
                management_and_fast_move="PASS", ledger_events=len(backend.events), successful_inventory_requests=len(backend.writes),
                submissions_and_offline_queue="PASS", exact_bin_contents="PASS", current_bin_search_single_column="PASS",
                direct_notes_and_not_found="PASS", part_uppercase_label="PASS", three_label_media_sizes="PASS", preserved_4x6_bin_label="PASS")


def workspace_checks(page,backend):
    import base64
    stock_count=len(backend.items)
    storage_before=page.evaluate('JSON.stringify(localStorage)')
    page.evaluate('openAddInventory()')
    page.wait_for_selector('#inventoryWorkspace.active')
    assert page.evaluate('workspace.ready')
    page.evaluate('workspaceCreateCard()')
    assert not backend.drafts
    page.fill('#workspaceInitials','qa')
    backend.lose_next_draft_create=True
    page.evaluate('workspaceCreateCard()')
    assert len(backend.drafts)==1
    page.evaluate('workspaceCreateCard()')
    assert len(backend.drafts)==1
    first=page.evaluate('workspace.selected')
    page.fill('#workspacePartName','Workspace test fan')
    page.select_option('#workspaceChassis','F30')
    page.locator('#workspaceCompatibleChassis input[value="F22"]').check()
    page.select_option('#workspaceCart','F30-A')
    page.select_option('#workspaceBin',uid(240))
    page.evaluate('workspaceFlush(workspace.selected)')
    assert backend.drafts[first]['data']['quantity'] is None
    assert set(backend.drafts[first]['data']['compatibility'])=={'F22','F30'}
    photo=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN7sAAAAASUVORK5CYII=')
    page.locator('#workspacePhotoInput').set_input_files({'name':'crew.png','mimeType':'image/png','buffer':photo})
    page.wait_for_function('workspace.uploading===0 && workspace.pending.size===0 && workspace.saving.size===0 && workspace.rows.get(workspace.selected).data.photo_paths.length===1')
    assert len(backend.photos)==1
    page.evaluate('workspacePrintCard()')
    assert 'DRAFT' in page.inner_text('#labelPrintCanvas')
    page.locator('#labelPrintCanvas').screenshot(path=str(OUTPUT/'workspace-draft-label.png'))
    assert_label_pdf(page,'workspace-draft-50x25mm.pdf',50*72/25.4,25*72/25.4)
    page.evaluate("showScreen('inventoryWorkspace')")
    page.evaluate('workspaceDuplicateCard()')
    second=page.evaluate('workspace.selected')
    assert first!=second and len(backend.drafts)==2 and len(backend.items)==stock_count
    assert backend.drafts[first]['tag_id']!=backend.drafts[second]['tag_id']
    assert backend.drafts[first]['data']['photo_paths']==backend.drafts[second]['data']['photo_paths']
    header=page.locator(f'.workspace-card-handle[data-card-id="{second}"]')
    header.scroll_into_view_if_needed();box=header.bounding_box()
    old_x=backend.drafts[second]['x']
    page.mouse.move(box['x']+50,box['y']+12);page.mouse.down();page.mouse.move(box['x']+100,box['y']+32,steps=5);page.mouse.up()
    page.evaluate('workspaceFlush(workspace.selected)')
    assert backend.drafts[second]['x']==old_x+50
    header.focus();header.press('ArrowRight');page.evaluate('workspaceFlush(workspace.selected)')
    assert backend.drafts[second]['x']==old_x+70
    # Independent browser context sees the same drafts/photos/positions without device persistence.
    context=page.context.browser.new_context(viewport={'width':390,'height':844})
    other=context.new_page();other.route('**/rest/v1/**',backend.route);other.route('**/storage/v1/**',backend.route)
    other.on('dialog',lambda dialog:dialog.accept())
    other.goto(base_url);other.wait_for_function('vehicleRegistryReady')
    other.evaluate('openInventoryWorkspace()');other.evaluate('(id)=>workspaceSelect(id)',second)
    assert other.input_value('#workspacePartName')=='Workspace test fan'
    assert other.input_value('#workspaceQuantity')==''
    assert other.evaluate('(id)=>workspace.rows.get(id).x',second)==old_x+70
    other.fill('#workspaceInitials','qb')
    page.fill('#workspaceNotes','Pending local edit')
    page.evaluate('clearTimeout(workspace.timers.get(workspace.selected))')
    other.fill('#workspaceNotes','Shared edit from another device');other.evaluate('workspaceFlush(workspace.selected)')
    page.evaluate('workspaceFlush(workspace.selected)')
    assert page.evaluate('workspace.errors.has(workspace.selected)')
    assert backend.drafts[second]['data']['notes']=='Shared edit from another device'
    assert page.input_value('#workspaceNotes')=='Pending local edit'
    page.locator('#workspaceReloadCard').click()
    page.wait_for_function('workspace.errors.size===0')
    page.wait_for_function("document.getElementById('workspaceNotes').value==='Shared edit from another device'")
    other.screenshot(path=str(OUTPUT/'workspace-mobile.png'),full_page=True)
    context.close()
    page.fill('#workspaceQuantity','1');page.evaluate('workspaceFlush(workspace.selected)')
    backend.lose_next_draft_commit=True
    page.evaluate('workspaceCommitCard()')
    assert len(backend.items)==stock_count+1
    assert backend.drafts[second]['inventory_item_id']==second
    page.locator('#workspaceAddAnotherPart').click()
    page.wait_for_function('(known)=>!known.includes(workspace.selected)',arg=[first,second])
    third=page.evaluate('workspace.selected')
    assert third not in [first,second]
    assert page.input_value('#workspacePartName')==page.input_value('#workspaceQuantity')==''
    # Matching stock requires an explicit Add / Replace / Separate decision.
    page.fill('#workspacePartName','Workspace test fan');page.fill('#workspaceQuantity','2')
    page.select_option('#workspaceChassis','F30')
    page.evaluate('workspaceCommitCard()');page.wait_for_selector('#inventoryIntakeReview.active')
    assert len(backend.items)==stock_count+1
    assert page.locator('#intakeConfirm').is_disabled()
    page.select_option('#intakeExistingItem',second);page.select_option('#intakeMode','replace')
    assert '1 → 2' in page.inner_text('#intakeChoicePreview')
    page.select_option('#intakeMode','add')
    assert '1 + 2 = 3' in page.inner_text('#intakeChoicePreview')
    page.locator('#intakeConfirm').click();page.wait_for_selector('#inventoryWorkspace.active')
    assert backend.find_item(second)['quantity']==3 and len(backend.items)==stock_count+1
    assert backend.drafts[third]['inventory_item_id']==second
    assert page.evaluate('(tag)=>findInventoryItem(tag).id',backend.drafts[third]['tag_id'])==second
    page.evaluate('workspaceArchiveCard()')
    assert backend.drafts[third]['state']=='archived'
    page.evaluate('workspaceToggleArchived(true)');page.evaluate('(id)=>workspaceSelect(id)',third)
    page.evaluate('workspaceRestoreCard()');assert backend.drafts[third]['state']=='committed'
    page.screenshot(path=str(OUTPUT/'workspace-desktop.png'),full_page=True)
    assert_handlers(page)
    assert page.evaluate('JSON.stringify(localStorage)')==storage_before
    # A parent cart move carries all sub-bins and leaves part counts alone.
    page.evaluate("openBinDetail('E92-018')")
    page.locator('#binManagementControls summary').click()
    page.select_option('#binCartLocationSelect','B');page.fill('#binCartInitials','cc');page.evaluate('saveBinCartLocation()')
    assert all(row['cart_location']=='B' for row in backend.bins if row['bin_code'] in ['E92-018','E92-018-A','E92-018-B'])
    page.evaluate("openBinDetail('E92-018-A')")
    assert page.locator('#binCartLocationSelect').is_disabled()
    page.evaluate("openBinDetail('E92-018')")
    page.locator('#binManagementControls summary').click()
    page.select_option('#binCartLocationSelect','A');page.fill('#binCartInitials','cc');page.evaluate('saveBinCartLocation()')
    # Correct an entry error without changing stock, source lineage or unsaved Notes.
    page.evaluate('(id)=>openInventoryDetail(id)',second)
    page.fill('#inventoryDetailNotes','Unsaved note stays')
    before_part=copy.deepcopy(backend.find_item(second))
    page.fill('#inventoryDetailName','Corrected workspace fan')
    attempts=len(backend.attempts);page.evaluate('saveInventoryPartName()');assert len(backend.attempts)==attempts
    page.fill('#inventoryDetailInitials','pn');page.evaluate('saveInventoryPartName()')
    assert page.input_value('#inventoryDetailNotes')=='Unsaved note stays'
    assert backend.find_item(second)['item_name']=='Corrected workspace fan'
    for field in ['id','quantity','tag_id','inventory_bin_id','source_metadata']:assert backend.find_item(second)[field]==before_part[field]
    # Remove a real fixture bin only after choosing where every record goes.
    page.evaluate("openBinDetail('E92-008')")
    page.locator('#binManagementControls summary').click()
    page.fill('#binDisplayName','Crew cooling spares')
    attempts=len(backend.attempts);page.evaluate('saveInventoryBinName()');assert len(backend.attempts)==attempts
    page.fill('#binCartInitials','bn');page.evaluate('saveInventoryBinName()')
    assert next(row for row in backend.bins if row['bin_code']=='E92-008')['name']=='Crew cooling spares'
    assert 'Crew cooling spares' in page.inner_text('#binDetailWrap h2')
    page.evaluate('openDeleteInventoryBin()')
    page.wait_for_selector('#deleteBinDestination')
    before={row['id']:row['quantity'] for row in backend.items}
    attempts=len(backend.attempts);page.evaluate('deleteInventoryBin()');assert len(backend.attempts)==attempts
    page.select_option('#deleteBinDestination','backstock');page.fill('#deleteBinInitials','db')
    page.locator('#deleteBinConfirm').click();page.wait_for_function('binDeletion===null')
    assert next(row for row in backend.bins if row['bin_code']=='E92-008')['status']=='Archived'
    assert {row['id']:row['quantity'] for row in backend.items}==before
    assert all(row['inventory_bin_id']!=uid(208) for row in backend.items)
    page.evaluate("openBinBrowser('E92')")
    assert 'E92-008' not in page.locator('#binResults').inner_text()


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
        page.route("**/storage/v1/**", backend.route)
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
