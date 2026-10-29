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

  function listCopyForDrawer(tasks, key, boardShown) {
    if (!boardShown || !key) return null;
    return (tasks || []).find((t) => t.key === key) || null;
  }

  // Is the open card read-only: the task sits in a column only Claude moves (the board's WORKING —
  // keep the two lists in step), unless it is a manual task (label noclaude), which a person moves
  // through every status by hand. One answer for opening the card and for a status that changed
  // outside while it is open.
  const LOCKED_STATUSES = ['prep', 'doing', 'deploy'];
  function cardLocked(status, labels) {
    return LOCKED_STATUSES.includes(status) && !(Array.isArray(labels) && labels.includes('noclaude'));
  }

  return { shouldSyncDrawerStatus, listCopyForDrawer, cardLocked, LOCKED_STATUSES };
});
