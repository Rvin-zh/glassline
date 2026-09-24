function safeErrorMessage(error, fallback) {
  const message = typeof error?.message === 'string'
    ? error.message.trim()
    : '';
  return message || fallback;
}

export function createAutoScreenScheduler({
  runCycle,
  isBusy = () => false,
  getIntervalMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onStateChange = () => {},
  onAutoDisabled = () => {},
  failureLimit = 3
}) {
  let enabled = false;
  let running = false;
  let timerId = null;
  let consecutiveFailures = 0;

  function getState() {
    return {
      enabled,
      running,
      consecutiveFailures,
      scheduled: timerId !== null
    };
  }

  function notifyStateChange() {
    onStateChange(getState());
  }

  function clearPendingTimer() {
    if (timerId === null) {
      return;
    }
    clearTimeoutFn(timerId);
    timerId = null;
  }

  function normalizedIntervalMs() {
    const intervalMs = Number(getIntervalMs?.());
    return Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : 10_000;
  }

  function scheduleNext() {
    clearPendingTimer();
    if (!enabled || running) {
      return;
    }
    timerId = setTimeoutFn(() => {
      timerId = null;
      return runNow();
    }, normalizedIntervalMs());
    notifyStateChange();
  }

  function disable(reason = 'user') {
    const changed = enabled || timerId !== null;
    enabled = false;
    clearPendingTimer();
    if (changed) {
      notifyStateChange();
    }
    return {
      ...getState(),
      reason
    };
  }

  function disableAutomatically(reason, result) {
    enabled = false;
    clearPendingTimer();
    const details = {
      reason,
      consecutiveFailures,
      error: String(result?.error || 'Auto Screen failed')
    };
    notifyStateChange();
    onAutoDisabled(details);
    return details;
  }

  async function runNow() {
    if (!enabled) {
      return { success: false, skipped: true, reason: 'disabled' };
    }
    if (running) {
      return { success: false, skipped: true, reason: 'running' };
    }
    if (isBusy()) {
      const result = { success: false, skipped: true, reason: 'busy' };
      scheduleNext();
      return result;
    }

    running = true;
    notifyStateChange();
    let result;
    try {
      result = await runCycle();
    } catch (error) {
      result = {
        success: false,
        error: safeErrorMessage(error, 'Auto Screen cycle failed')
      };
    } finally {
      running = false;
    }

    if (result?.busy === true || result?.skipped === true) {
      if (enabled) {
        scheduleNext();
      } else {
        notifyStateChange();
      }
      return result;
    }

    if (result?.success === false) {
      if (result.fatal === true) {
        disableAutomatically('fatal', result);
        return result;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= failureLimit && enabled) {
        disableAutomatically('failure-limit', result);
        return result;
      }
    } else {
      consecutiveFailures = 0;
    }

    if (enabled) {
      scheduleNext();
    } else {
      notifyStateChange();
    }
    return result;
  }

  function enable() {
    if (enabled) {
      return Promise.resolve({
        success: true,
        alreadyEnabled: true,
        ...getState()
      });
    }
    enabled = true;
    consecutiveFailures = 0;
    clearPendingTimer();
    notifyStateChange();
    return runNow();
  }

  function refreshInterval() {
    if (enabled && !running) {
      scheduleNext();
    }
    return getState();
  }

  return {
    disable,
    enable,
    getState,
    refreshInterval,
    runNow
  };
}

export function createAutoScreenController({
  captureScreenshot,
  analyzeScreenshot,
  isAiAvailable,
  isBusy,
  runExclusive,
  getIntervalMs,
  setTimeoutFn,
  clearTimeoutFn,
  onStateChange,
  onAutoDisabled
}) {
  async function captureAndAnalyze(origin) {
    if (!isAiAvailable()) {
      return {
        success: false,
        fatal: true,
        error: 'AI provider is not ready. Configure it in Settings.'
      };
    }

    if (isBusy()) {
      return {
        success: false,
        busy: true,
        code: 'ASSISTANT_ACTION_BUSY'
      };
    }

    try {
      const exclusive = await runExclusive('screenAi', async () => {
        const captureResult = await captureScreenshot(origin);
        if (captureResult?.busy === true || captureResult?.code === 'SCREENSHOT_BUSY') {
          return {
            success: false,
            busy: true,
            code: 'SCREENSHOT_BUSY'
          };
        }
        if (
          captureResult?.success !== true ||
          typeof captureResult.screenshotId !== 'string' ||
          !captureResult.screenshotId
        ) {
          return {
            success: false,
            error: String(captureResult?.error || 'Screenshot capture failed')
          };
        }

        const analysisResult = await analyzeScreenshot({
          screenshotIds: [captureResult.screenshotId],
          origin
        });
        if (analysisResult?.success === false) {
          return {
            success: false,
            error: String(analysisResult.error || 'Screen AI analysis failed')
          };
        }

        return {
          success: true,
          screenshotId: captureResult.screenshotId,
          capture: captureResult,
          analysis: analysisResult
        };
      });

      if (exclusive?.acquired === false) {
        return {
          success: false,
          busy: true,
          code: 'ASSISTANT_ACTION_BUSY'
        };
      }
      return exclusive?.value || {
        success: false,
        error: 'Auto Screen action did not return a result'
      };
    } catch (error) {
      return {
        success: false,
        error: safeErrorMessage(error, 'Screenshot capture or analysis failed')
      };
    }
  }

  const scheduler = createAutoScreenScheduler({
    runCycle: () => captureAndAnalyze('auto'),
    isBusy,
    getIntervalMs,
    setTimeoutFn,
    clearTimeoutFn,
    onStateChange,
    onAutoDisabled
  });

  return {
    captureManualScreenshot: () => captureAndAnalyze('manual'),
    disableAutoScreen: (reason) => scheduler.disable(reason),
    enableAutoScreen: () => scheduler.enable(),
    getState: () => scheduler.getState(),
    refreshInterval: () => scheduler.refreshInterval(),
    runAutoScreenNow: () => scheduler.runNow()
  };
}
