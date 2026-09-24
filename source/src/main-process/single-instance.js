'use strict';

function acquireSingleInstance(app) {
  const acquired = Boolean(app?.requestSingleInstanceLock?.());
  if (!acquired) {
    app?.quit?.();
  }
  return acquired;
}

function revealExistingInstance(windowController) {
  if (!windowController?.hasWindow?.()) {
    return false;
  }

  windowController.markVisible?.();
  const windowRef = windowController.getMainWindow?.();
  if (!windowRef || windowRef.isDestroyed?.()) {
    return false;
  }

  if (windowRef.isMinimized?.()) {
    windowRef.restore?.();
  }
  windowRef.show?.();
  windowRef.focus?.();
  return true;
}

module.exports = {
  acquireSingleInstance,
  revealExistingInstance
};
