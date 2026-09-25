const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chooseLayer, folioScriptPath, listLayers } = require('../src/platform/external-layers');

test('Folio is an external layer beside Interview', () => {
  const layers = listLayers();
  assert.deepEqual(layers.map((layer) => layer.id), ['interview', 'folio']);
  assert.equal(layers.find((layer) => layer.id === 'folio').external, true);
  assert.equal(chooseLayer('interview').external, false);
  assert.equal(chooseLayer('missing').ok, false);
});

test('the overlay offers Folio as a choice', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../src/windows/assistant/renderer.html'),
    'utf8'
  );
  assert.match(html, /id="external-layer-select"/);
  assert.match(html, /<option value="folio">Folio<\/option>/);
});

test('Folio resolves to the packaged script before the repo copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-layer-'));
  const packaged = path.join(root, 'folio', 'bin');
  fs.mkdirSync(packaged, { recursive: true });
  fs.writeFileSync(path.join(packaged, 'cv-studio.js'), '');
  const resolved = folioScriptPath({ resourcesPath: root, repoRoot: '/unused' });
  assert.equal(resolved, path.join(packaged, 'cv-studio.js'));
});
