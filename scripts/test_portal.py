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
bins=[]; writes=[]; errors=[]; alerts=[]; submissions=[]; offline=False
def route_api(route):
    request=route.request; path=request.url.split('/rest/v1/')[-1].split('?')[0]
    if offline and path=='submissions':
        route.abort('internetdisconnected');return
    data=request.post_data_json if request.method in ['POST','PATCH'] else None
    if request.method!='GET': writes.append((path,data))
    if path=='vehicles': result=registry
    elif path=='inventory_bins':
        if request.method=='POST': bins.append(dict(data,id='22222222-2222-4222-8222-222222222222'))
        result=bins
    elif path=='inventory_items':
        if request.method=='PATCH': item.update(data)
        result=[item]
    elif path=='rpc/assign_inventory_to_bin':
        item.update(inventory_bin_id=bins[0]['id'],location=bins[0]['bin_code']); result=item['id']
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
    page.evaluate('openLabelAssistant()'); page.wait_for_function('inventoryBinsReady')
    page.evaluate('openCreateBin()')
    page.select_option('#binMake','BMW');page.select_option('#binModel','F30');page.select_option('#binSystem','Brakes');page.select_option('#binSubsystem','Pads')
    assert page.locator('#binCodePreview').inner_text()=='B-F30-BRK-PAD-01'
    page.fill('#binLocation','Shelf A')
    page.evaluate('createInventoryBin()')
    page.wait_for_selector('#binDetail.active');assert page.locator('#binDetail').evaluate('(e)=>e.classList.contains("active")')
    handlers()
    page.evaluate('openBinLabel()')
    page.pdf(path=str(output/'bin-label.pdf'),prefer_css_page_size=True)
    page.evaluate('openAssignPartToBin("B-F30-BRK-PAD-01","TEST-01")')
    handlers()
    page.fill('#assignPartQty','1.5'); before=len(writes);page.evaluate('assignSelectedPartToBin()');assert len(writes)==before
    page.fill('#assignPartQty','10'); page.evaluate('Promise.all([assignSelectedPartToBin(),assignSelectedPartToBin()])')
    assert len([w for w in writes if w[0].startswith('rpc/')])==1
    page.evaluate('openInventoryDetail("TEST-01")');handlers()
    page.evaluate('openPartTag("TEST-01")')
    page.check('#partTagAdjustCount');page.fill('#partTagNewQty','1.5');before=len(writes);page.evaluate('preparePartTag()');assert len(writes)==before
    page.fill('#partTagNewQty','0');page.evaluate('preparePartTag()');assert item['quantity']==0 and item['tag_id']
    assert page.locator('.part-tag-face').count()==4 and page.locator('.part-tag-face.rotate').count()==2
    dimensions=page.locator('#labelPrintCanvas').bounding_box();assert dimensions['width']==384 and dimensions['height']==576
    tag=item['tag_id'];page.evaluate('preparePartTag()');assert item['tag_id']==tag
    page.pdf(path=str(output/'part-tag.pdf'),prefer_css_page_size=True)
    page.screenshot(path=str(output/'label-preview.png'),full_page=True)
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
    print(json.dumps({'result':'PASS','screens_with_home_navigation':len(screens),'vehicle_registry':23,'bin_id':bins[0]['bin_code'],'rpc_requests_after_double_submit':1,'part_faces':4,'rotated_faces':2,'print_canvas_px':[384,576],'invalid_quantities_blocked':True,'runtime_errors':errors,'mock_write_count':len(writes),'unknown_counts_and_units':'PASS','postevent_admin_offline_queue':'PASS','artifacts':str(output)},indent=2))
    browser.close()
server.shutdown()
