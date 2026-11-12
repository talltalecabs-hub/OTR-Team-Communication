#!/usr/bin/env python3
"""Local browser regression with intercepted Supabase requests; no production reads/writes.
Requires Python Playwright and Chromium (CHROMIUM_PATH overrides /usr/bin/chromium).
PDFs and screenshot go to OTR_TEST_OUTPUT or a temporary directory.
"""
import os, tempfile
import json, re, threading, functools
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
output=Path(os.environ.get('OTR_TEST_OUTPUT',tempfile.mkdtemp(prefix='otr-portal-check-')))
output.mkdir(parents=True,exist_ok=True)
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base_url=f'http://127.0.0.1:{server.server_address[1]}'
item=dict(id='11111111-1111-4111-8111-111111111111',inventory_code='TEST-01',local_key='TEST-01',item_name='Brake Pads',quantity=10,platform='F30',location='Shelf A',category='Brakes',condition='New',verification_status='Verified')
registry_source=(root/'assets/core.js').read_text().split('const fallbackVehicleRegistry = ',1)[1].split(';',1)[0]
registry=json.loads(re.sub(r'([a-z_]+):',r'"\1":',registry_source))
backstock_item=dict(id='44444444-4444-4444-8444-444444444444',inventory_code='SHOP-01',local_key='SHOP-01',item_name='Shop Bolts',quantity=6,platform='F30',location='Shop shelf',category='Fasteners',condition='New',stock_category='Backstock')
carts=[{'cart_code':f'{code}-{letter}','platform':platform,'cart_letter':letter} for platform,code in [('E92','E92'),('F22','F22'),('F30','F30'),('986 Boxster','986')] for letter in ['A','B']]
created_items=[]
bins=[]; writes=[]; errors=[]; alerts=[]; submissions=[]; offline=False
def route_api(route):
    request=route.request; path=request.url.split('/rest/v1/')[-1].split('?')[0]
    if offline and path=='submissions':
        route.abort('internetdisconnected');return
    data=request.post_data_json if request.method in ['POST','PATCH'] else None
    if request.method!='GET': writes.append((path,data))
    if path=='vehicles': result=registry
    elif path=='inventory_carts': result=carts
    elif path=='inventory_bins':
        if request.method=='POST': bins.append(dict(data,id='22222222-2222-4222-8222-222222222222'))
        if request.method=='PATCH':
            target=next(row for row in bins if 'id=eq.'+row['id'] in request.url);target.update(data)
        result=bins
    elif path=='inventory_items':
        if request.method=='PATCH':
            target=next(row for row in [item,backstock_item,*created_items] if 'id=eq.'+row['id'] in request.url)
            target.update(data)
        if request.method=='POST':
            saved=dict(data,id='55555555-5555-4555-8555-'+f'{len(created_items)+1:012d}');created_items.append(saved);result=[saved]
        else: result=[item,backstock_item,*created_items]
    elif path=='rpc/assign_inventory_to_bin':
        dest=next(row for row in bins if row['id']==data['p_bin_id']);item.update(inventory_bin_id=dest['id'],location=dest['bin_code'],cart_code=data.get('p_cart_code'));result=item['id']
    elif path=='submissions':
        if request.method=='POST': submissions.append(dict(data,id=str(len(submissions)+1)))
        result=submissions
    else: raise Exception(path)
    route.fulfill(status=200,content_type='application/json',body=json.dumps(result),headers={'access-control-allow-origin':'*'})

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1280,'height':1000})
    page.route('**/rest/v1/**',route_api)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('dialog',lambda d:(alerts.append(d.message),d.accept()))
    page.goto(base_url)
    page.wait_for_function('vehicleRegistryReady',timeout=10000)
    assert page.evaluate('vehicleRegistry.length')==23
    # Static and generated inline handler names resolve in the actual browser runtime.
    def handlers():
        missing=page.evaluate(r'''() => [...document.querySelectorAll('*')].flatMap(e=>[...e.attributes].filter(a=>/^on/.test(a.name)).flatMap(a=>[...a.value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]))).filter(n=>typeof window[n]!=='function')''')
        assert not missing,missing
    handlers()
    assert page.evaluate('APP_VERSION')=='1.2.0'
    page.evaluate('openInventoryAssistant()');page.locator('#inventoryHome [onclick="openMobileInventory()"] ').click()
    assert page.locator('#inventoryMobile.active').count()==1
    page.evaluate('browseInventory("F30")');page.wait_for_function('inventoryBackendReady')
    assert page.locator('#inventoryResults .inventory-card').count()==1
    assert 'Brake Pads' in page.locator('#inventoryResults').inner_text()
    assert 'Shop Bolts' not in page.locator('#inventoryResults').inner_text()
    page.evaluate('browseInventory("ALL","Backstock")')
    assert page.locator('#inventoryResults .inventory-card').count()==1
    assert 'Shop Bolts' in page.locator('#inventoryResults').inner_text()
    page.select_option('#inventoryPlatformFilter','F30')
    page.select_option('#inventoryStockCategoryFilter','ALL')
    assert page.locator('#inventoryResults .inventory-card').count()==2
    page.select_option('#inventoryPlatformFilter','E92')
    assert page.locator('#inventoryResults .inventory-card').count()==0
    page.evaluate('openInventoryDetail("TEST-01")');before_quantity=item['quantity']
    page.evaluate('changeInventoryStockCategory("Backstock")')
    assert item['stock_category']=='Backstock' and item['quantity']==before_quantity and item['category']=='Brakes'
    assert set(writes[-1][1])=={'stock_category','updated_at'}
    page.evaluate('browseInventory("F30")');assert page.locator('#inventoryResults .inventory-card').count()==0
    page.evaluate('openInventoryDetail("TEST-01")');page.evaluate('changeInventoryStockCategory("Mobile")')
    page.evaluate('browseInventory("ALL","Backstock")');page.evaluate('openAddInventory()')
    assert page.input_value('#addStockCategory')=='Backstock'
    page.fill('#addItemName','Shop spare');page.fill('#addQty','2');page.fill('#addCategory','Cooling');page.select_option('#addPlatform','E92')
    page.evaluate('addInventoryItem()')
    assert created_items[-1]['stock_category']=='Backstock' and created_items[-1]['category']=='Cooling' and created_items[-1]['quantity']==2
    handlers()
    page.evaluate('openLabelAssistant()'); page.wait_for_function('inventoryBinsReady')
    page.evaluate('openCreateBin()')
    page.select_option('#binMake','BMW');page.select_option('#binModel','F30');page.select_option('#binSystem','Brakes');page.select_option('#binSubsystem','Pads')
    assert page.locator('#binCodePreview').inner_text()=='B-F30-BRK-PAD-01'
    page.fill('#binLocation','Shelf A');page.select_option('#binCartLocation','A')
    page.evaluate('createInventoryBin()')
    page.wait_for_selector('#binDetail.active');assert page.locator('#binDetail').evaluate('(e)=>e.classList.contains("active")')
    handlers()
    assert bins[0]['cart_location']=='A'
    page.select_option('#binCartLocationSelect','B');before_quantity=item['quantity'];page.evaluate('saveBinCartLocation()')
    assert bins[0]['cart_location']=='B' and item['quantity']==before_quantity
    assert writes[-1][0]=='inventory_bins' and set(writes[-1][1])=={'cart_location'}
    bins.append(dict(bins[0],id='66666666-6666-4666-8666-666666666666',bin_code='E92-CART-TEST',model='E92',cart_location='A'))
    page.evaluate('openBinBrowser("F30","A")');assert page.locator('#binResults .inventory-card').count()==0
    page.select_option('#binCartFilter','B');assert page.locator('#binResults .inventory-card').count()==1
    page.select_option('#binChassisFilter','E92');assert page.locator('#binResults .inventory-card').count()==0
    page.select_option('#binCartFilter','A');assert page.locator('#binResults .inventory-card').count()==1
    page.evaluate('openBinDetail("B-F30-BRK-PAD-01")')
    page.evaluate('openBinLabel()')
    page.pdf(path=str(output/'bin-label.pdf'),prefer_css_page_size=True)
    page.evaluate('openAssignPartToBin("B-F30-BRK-PAD-01","TEST-01")')
    handlers()
    page.fill('#assignPartQty','1.5'); before=len(writes);page.evaluate('assignSelectedPartToBin()');assert len(writes)==before
    page.fill('#assignPartQty','10'); page.evaluate('Promise.all([assignSelectedPartToBin(),assignSelectedPartToBin()])')
    assert len([w for w in writes if w[0].startswith('rpc/')])==1
    page.evaluate('browseInventory("F30")');page.evaluate('loadInventory()')
    page.select_option('#inventoryCartSelect','F30-B');assert page.locator('#inventoryResults .inventory-card').count()==1
    page.select_option('#inventoryCartSelect','F30-A');assert page.locator('#inventoryResults .inventory-card').count()==0
    page.select_option('#inventoryCartSelect','ALL')
    page.evaluate('openInventoryDetail("TEST-01")');handlers()
    fields=page.locator('#inventoryDetailWrap .inventory-field').evaluate_all('(els)=>Object.fromEntries(els.map(e=>[e.querySelector(".k").textContent,e.querySelector(".v").textContent]))')
    assert fields['Location']=='F30-B' and fields['Bin']=='B-F30-BRK-PAD-01' and fields['Assignment']=='Mobile Inventory',fields
    assert fields['Category']=='Brakes'
    page.evaluate('openPartTag("TEST-01")')
    page.check('#partTagAdjustCount');page.fill('#partTagNewQty','1.5');before=len(writes);page.evaluate('preparePartTag()');assert len(writes)==before
    page.fill('#partTagNewQty','0');page.evaluate('preparePartTag()');assert item['quantity']==0 and item['tag_id']
    assert page.locator('.part-tag-face').count()==4 and page.locator('.part-tag-face.rotate').count()==2
    dimensions=page.locator('#labelPrintCanvas').bounding_box();assert dimensions['width']==384 and dimensions['height']==576
    tag=item['tag_id'];page.evaluate('preparePartTag()');assert item['tag_id']==tag
    page.pdf(path=str(output/'part-tag.pdf'),prefer_css_page_size=True)
    page.screenshot(path=str(output/'label-preview.png'),full_page=True)
    # Every chassis has A/B carts, and one loose Bin ID can hold parts on both carts.
    assert page.evaluate('inventoryCarts.length')==8
    for index,(platform,code) in enumerate([('E92','E92'),('F22','F22'),('F30','F30'),('986 Boxster','986')]):
        bins.append(dict(id=f'77777777-7777-4777-8777-{index:012d}',bin_code=code+'-000',model=platform,make='BMW',system='Loose items',cart_location=None))
    page.evaluate('loadInventoryBins()')
    for cart in ['F30-A','F30-B']:
        page.evaluate('openAddInventory()');page.select_option('#addPlatform','F30');page.fill('#addItemName','Loose rotor '+cart);page.fill('#addQty','1')
        page.select_option('#addLocation',cart)
        loose=next(row for row in bins if row['bin_code']=='F30-000')
        page.select_option('#addBinId',loose['id']);page.evaluate('addInventoryItem()')
        assert created_items[-1]['cart_code']==cart and created_items[-1]['inventory_bin_id']==loose['id'] and created_items[-1]['stock_category']=='Mobile'
    assert created_items[-1]['inventory_bin_id']==created_items[-2]['inventory_bin_id']
    assert {row['cart_code'] for row in created_items[-2:]}=={'F30-A','F30-B'}
    # Backstock location and assignment stay synchronized.
    page.evaluate('openAddInventory()');page.select_option('#addLocation','Backstock')
    assert page.input_value('#addStockCategory')=='Backstock'
    page.select_option('#addStockCategory','Mobile');assert page.input_value('#addLocation')=='Unassigned'
    # Workbook unknowns and units survive detail, verification, moves and tag printing.
    source=json.loads((root/'data/inventory/f22-e92-2026-11-08.json').read_text())
    unknown=next(row for row in source['parts'] if row['quantity'] is None)
    item.clear();item.update(unknown,id='11111111-1111-4111-8111-111111111111',location=unknown['bin_code'],source_metadata=unknown.copy())
    page.evaluate('loadInventory()');key=item['inventory_code']
    page.evaluate('(key)=>openInventoryDetail(key)',key)
    assert 'Uncounted' in page.locator('#inventoryDetailWrap').inner_text()
    page.evaluate('openInventoryVerify()');assert page.input_value('#invQty')==''
    page.evaluate('saveInventoryVerification()');assert item['quantity'] is None
    page.evaluate('(key)=>openPartTag(key)',key);page.evaluate('preparePartTag()')
    assert 'Uncounted' in page.locator('#labelPrintCanvas').inner_text()
    page.evaluate('(key)=>openAssignPartToBin("B-F30-BRK-PAD-01",key)',key)
    page.fill('#assignPartQty','1');before=len(writes);page.evaluate('assignSelectedPartToBin()');assert len(writes)==before
    various=next(row for row in source['parts'] if row['quantity_raw']=='VARIOUS')
    item.clear();item.update(various,id='11111111-1111-4111-8111-111111111111',location=various['bin_code'],source_metadata=various.copy())
    page.evaluate('loadInventory()');page.evaluate('(key)=>openInventoryDetail(key)',item['inventory_code'])
    assert 'VARIOUS (uncounted)' in page.locator('#inventoryDetailWrap').inner_text()
    counted_set=next(row for row in source['parts'] if row['quantity_unit']=='sets' and row['quantity']>1)
    item.clear();item.update(counted_set,id='11111111-1111-4111-8111-111111111111',location=counted_set['bin_code'],source_metadata=counted_set.copy(),condition='Mixed')
    page.evaluate('loadInventory()');page.evaluate('(key)=>openInventoryDetail(key)',item['inventory_code'])
    assert f"{item['quantity']} sets" in page.locator('#inventoryDetailWrap').inner_text()
    page.evaluate('openInventoryVerify()');assert page.input_value('#invCondition')=='Mixed'
    page.evaluate('saveInventoryVerification()');assert item['condition']=='Mixed' and item['quantity_unit']=='sets'
    # Parent and sub-bin navigation does not claim untagged bins have zero stock.
    child=dict(bins[0],id='33333333-3333-4333-8333-333333333333',bin_code='TEST-SUB',parent_bin_id=bins[0]['id'])
    bins.append(child);page.evaluate('loadInventoryBins()');page.evaluate('openBinDetail("B-F30-BRK-PAD-01")')
    assert 'Sub-bins' in page.locator('#binDetailWrap').inner_text()
    assert 'does not establish a physical count of zero' in page.locator('#binDetailWrap').inner_text()
    handlers()
    # All existing screens retain functioning home navigation.
    screens=page.locator('.screen').evaluate_all('(els)=>els.map(e=>e.id)')
    for screen in screens:
        page.evaluate('(id)=>showScreen(id)',screen)
        page.evaluate('resetAndHome()')
        page.wait_for_function('document.getElementById("home").classList.contains("active")')
    # Existing feedback, reports, operational forms and local queue keep working.
    page.evaluate('activeCategory="Mechanical / Cars";document.getElementById("quickText").value="Smoke test";submitQuick()')
    assert writes[-1][1]['submission_type']=='feedback_quick'
    page.evaluate('answers={test:"Detailed smoke test"};submitDetailed()')
    assert writes[-1][1]['submission_type']=='feedback_detailed'
    page.evaluate('document.getElementById("peEvent").value="Test event";document.getElementById("peRole").selectedIndex=1;document.getElementById("pe4").value="Worked well";submitPostEvent()')
    assert writes[-1][1]['submission_type']=='post_event_report'
    page.evaluate('loadAdminSubmissions()')
    assert 'Test event' in page.locator('#adminSubmissionsList').inner_text()
    offline=True
    page.evaluate('document.getElementById("quickText").value="Offline smoke test";submitQuick()')
    assert page.evaluate('getStore().length')==1
    page.evaluate('showScreen("admin")');assert 'Offline smoke test' in page.locator('#admin').inner_text()
    offline=False;page.evaluate('syncQueue()');assert page.evaluate('getStore().length')==0
    for key in page.evaluate('Object.keys(operationalFormDefinitions)'):
        page.evaluate('(key)=>openOperationalForm(key)',key);handlers()
    assert not errors,errors
    print(json.dumps({'result':'PASS','screens_with_home_navigation':len(screens),'vehicle_registry':23,'bin_id':bins[0]['bin_code'],'rpc_requests_after_double_submit':1,'part_faces':4,'rotated_faces':2,'print_canvas_px':[384,576],'invalid_quantities_blocked':True,'runtime_errors':errors,'mock_write_count':len(writes),'cart_registry_and_loose_bins':'PASS','chassis_cart_assignment_and_filters':'PASS','mobile_backstock_filters_and_writes':'PASS','unknown_counts_and_units':'PASS','postevent_admin_offline_queue':'PASS','artifacts':str(output)},indent=2))
    browser.close()
server.shutdown()
