const fs = require('fs');
const path = require('path');

const LAYERS = [
  { id: 'interview', label: 'Interview', external: false },
  { id: 'folio', label: 'Folio', external: true }
];

function listLayers() {
  return LAYERS.map((layer) => ({ ...layer }));
}

function chooseLayer(layerId) {
  const layer = LAYERS.find((item) => item.id === layerId);
  if (!layer) {
    return { ok: false, error: 'Unknown layer' };
  }
  return { ok: true, layer: layer.id, label: layer.label, external: layer.external };
}

function folioScriptPath({ resourcesPath, repoRoot }) {
  const packaged = path.join(resourcesPath || '', 'folio', 'bin', 'cv-studio.js');
  if (resourcesPath && fs.existsSync(packaged)) {
    return packaged;
  }
  return path.join(repoRoot, 'cv-studio', 'bin', 'cv-studio.js');
}

module.exports = {
  listLayers,
  chooseLayer,
  folioScriptPath
};
