initializePortalHistory();
renderCategories();
loadVehicleRegistry();

const runtimeChecks={
  submitQuick,
  submitDetailed,
  submitPostEvent,
  submitOperationalForm,
  genericSubmit,
  openOperationalForm,
  leaveOperationalForm,
  loadVehicleRegistry,
  refreshOperationalVehicleOptions,
  renderAdmin,
  cryptoId,
  resetAndHome,
  portalBack,
  initializePortalHistory,
  sendToSupabase,
  loadInventory
};

const missingRuntimeFunctions=Object.entries(runtimeChecks)
  .filter(([,value])=>typeof value!=="function")
  .map(([name])=>name);

if(missingRuntimeFunctions.length){
  console.error("OTR portal runtime check failed", missingRuntimeFunctions);
}else{
  console.info(`OTR portal V${APP_VERSION} runtime check passed`);
}

syncQueue();
window.addEventListener("online", syncQueue);
