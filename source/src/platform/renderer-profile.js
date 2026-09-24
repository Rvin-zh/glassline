'use strict';

function resolveRendererProfile({
  platform = process.platform,
  fullEffects = process.env.OPEN_CLUELY_FULL_EFFECTS
} = {}) {
  const normalizedPlatform = String(platform || 'unknown').trim().toLowerCase() || 'unknown';
  const reducedEffects = normalizedPlatform === 'linux' && String(fullEffects || '').trim() !== '1';

  return {
    platformClass: `platform-${normalizedPlatform}`,
    reducedEffects
  };
}

function applyRendererProfile(documentRef, profile = resolveRendererProfile()) {
  const root = documentRef?.documentElement;
  if (!root?.classList) {
    return false;
  }

  root.classList.add(profile.platformClass);
  root.classList.toggle('reduced-effects', profile.reducedEffects);
  return true;
}

function installRendererProfile(documentRef, profile = resolveRendererProfile()) {
  if (applyRendererProfile(documentRef, profile)) {
    return 'applied';
  }

  if (typeof documentRef?.addEventListener === 'function') {
    documentRef.addEventListener(
      'DOMContentLoaded',
      () => applyRendererProfile(documentRef, profile),
      { once: true }
    );
    return 'deferred';
  }

  return 'unavailable';
}

module.exports = {
  applyRendererProfile,
  installRendererProfile,
  resolveRendererProfile
};
