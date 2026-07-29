(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DrawerSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function shouldSyncDrawerStatus(baseline, selectValue, serverStatus) {
    if (serverStatus == null) return false;
    if (serverStatus === baseline) return false;
    if (selectValue !== baseline) return false;
    return true;
  }

  return { shouldSyncDrawerStatus };
});
